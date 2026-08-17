package ws

import (
	"crypto/rand"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/gorilla/websocket"
)

const (
	// Time allowed to write a message to the peer.
	writeWait = 10 * time.Second

	// Time allowed to read the next pong message from the peer.
	pongWait = 60 * time.Second

	// Send pings to peer with this period. Must be less than pongWait.
	pingPeriod = (pongWait * 9) / 10

	// Maximum message size allowed from peer.
	maxMessageSize = 512 * 1024 // 512KB to accommodate signaling messages
)

// WSMessage encapsulates a WebSocket message type and payload
type WSMessage struct {
	Type int
	Data []byte
}

// Message is the standard communication structure.
type Message struct {
	Type    string      `json:"type"`
	Payload interface{} `json:"payload,omitempty"`
}

// Client represents an active WebSocket connection.
type Client struct {
	ID           string
	Name         string
	Device       string
	Hub          *Hub
	Room         *Room
	Conn         *websocket.Conn
	Send         chan WSMessage
	RelayPartner *Client // Bi-directional pointer to partner for fallback relay channel
	DefaultRoom  string  // Initial IP-based room to reset back to
}

// NewClient initializes a new Client.
func NewClient(hub *Hub, conn *websocket.Conn, name, device, defaultRoom string) *Client {
	return &Client{
		ID:          generateID(),
		Name:        name,
		Device:      device,
		Hub:         hub,
		Conn:        conn,
		Send:        make(chan WSMessage, 1024), // Large channel for binary frame buffering
		DefaultRoom: defaultRoom,
	}
}

// SendJSON marshals and enqueues a JSON message to the client's write channel.
func (c *Client) SendJSON(msg Message) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal JSON message: %v\n", err)
		return
	}
	select {
	case c.Send <- WSMessage{Type: websocket.TextMessage, Data: data}:
	default:
		log.Printf("Send queue full for client %s, closing connection\n", c.ID)
		c.Conn.Close()
	}
}

// ReadPump pumps messages from the websocket connection to the hub.
func (c *Client) ReadPump() {
	defer func() {
		c.Hub.LeaveRoom(c)
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		messageType, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Unexpected close error: %v\n", err)
			}
			break
		}

		// Handle raw binary frames for fallback file relay or broadcast
		if messageType == websocket.BinaryMessage {
			c.Room.Mu.RLock()
			partner := c.RelayPartner
			isBroadcasting := c.Room.ActiveBroadcaster == c
			c.Room.Mu.RUnlock()

			if isBroadcasting {
				// Broadcast binary frame to all other clients in the room
				c.Room.Mu.RLock()
				for _, peer := range c.Room.Clients {
					if peer.ID != c.ID {
						select {
						case peer.Send <- WSMessage{Type: websocket.BinaryMessage, Data: message}:
						default:
							log.Printf("Peer %s queue full during broadcast, dropping binary frame\n", peer.ID)
						}
					}
				}
				c.Room.Mu.RUnlock()
			} else if partner != nil {
				select {
				case partner.Send <- WSMessage{Type: websocket.BinaryMessage, Data: message}:
				default:
					log.Printf("Partner %s queue full, dropping binary frame\n", partner.ID)
				}
			} else {
				log.Println("Received binary frame but no relay partner or broadcast is active")
			}
			continue
		}

		var msg Message
		if err := json.Unmarshal(message, &msg); err != nil {
			log.Printf("Failed to unmarshal message: %v\n", err)
			continue
		}

		c.handleIncomingMessage(msg)
	}
}

// WritePump pumps messages from the client's send channel to the websocket connection.
func (c *Client) WritePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			// Send exact frame type (TextMessage or BinaryMessage)
			err := c.Conn.WriteMessage(message.Type, message.Data)
			if err != nil {
				return
			}

		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// handleIncomingMessage processes messages sent by the client.
func (c *Client) handleIncomingMessage(msg Message) {
	switch msg.Type {
	case "join-room":
		var code string
		if payloadMap, ok := msg.Payload.(map[string]interface{}); ok {
			if codeVal, exists := payloadMap["code"].(string); exists {
				code = codeVal
			}
		}
		if code != "" {
			c.Hub.JoinRoom(code, c)
		} else {
			c.Hub.JoinRoom(c.DefaultRoom, c)
		}

	case "signal":
		if payloadMap, ok := msg.Payload.(map[string]interface{}); ok {
			targetID, _ := payloadMap["targetId"].(string)
			signalData := payloadMap["signal"]

			if targetID != "" && signalData != nil && c.Room != nil {
				c.Room.Mu.RLock()
				targetClient, exists := c.Room.Clients[targetID]
				c.Room.Mu.RUnlock()

				if exists {
					targetClient.SendJSON(Message{
						Type: "signal",
						Payload: map[string]interface{}{
							"senderId": c.ID,
							"signal":   signalData,
						},
					})
				} else {
					log.Printf("Signal target %s not found in room %s\n", targetID, c.Room.ID)
				}
			}
		}

	case "relay-request":
		if payloadMap, ok := msg.Payload.(map[string]interface{}); ok {
			targetID, _ := payloadMap["targetId"].(string)
			if targetID != "" && c.Room != nil {
				c.Room.Mu.Lock()
				targetClient, exists := c.Room.Clients[targetID]
				if exists {
					// Set partners bi-directionally
					c.RelayPartner = targetClient
					targetClient.RelayPartner = c
					log.Printf("WebSocket fallback relay handshaking between %s and %s\n", c.ID, targetID)
				}
				c.Room.Mu.Unlock()

				if exists {
					// Notify both parties that relay setup is ready
					c.SendJSON(Message{
						Type: "relay-ready",
						Payload: map[string]interface{}{
							"role":     "sender",
							"targetId": targetID,
						},
					})
					targetClient.SendJSON(Message{
						Type: "relay-ready",
						Payload: map[string]interface{}{
							"role":     "receiver",
							"targetId": c.ID,
						},
					})
				}
			}
		}

	case "relay-meta":
		if c.Room != nil {
			c.Room.Mu.RLock()
			partner := c.RelayPartner
			c.Room.Mu.RUnlock()

			if partner != nil {
				partner.SendJSON(Message{
					Type:    "relay-meta",
					Payload: msg.Payload,
				})
			}
		}

	case "broadcast-start":
		if c.Room != nil {
			c.Room.Mu.Lock()
			hasBroadcaster := c.Room.ActiveBroadcaster != nil
			if !hasBroadcaster {
				c.Room.ActiveBroadcaster = c
				log.Printf("Client %s starting broadcast in room %s\n", c.ID, c.Room.ID)
			}
			c.Room.Mu.Unlock()

			if hasBroadcaster {
				c.SendJSON(Message{
					Type: "broadcast-error",
					Payload: map[string]interface{}{
						"message": "Another device is currently broadcasting a file.",
					},
				})
			} else {
				// Send meta to all other clients in the room
				c.Hub.broadcastToRoomExcept(c.Room, c.ID, Message{
					Type: "broadcast-meta",
					Payload: map[string]interface{}{
						"senderId":   c.ID,
						"senderName": c.Name,
						"name":       msg.Payload.(map[string]interface{})["name"],
						"size":       msg.Payload.(map[string]interface{})["size"],
						"mime":       msg.Payload.(map[string]interface{})["mime"],
					},
				})
			}
		}

	case "broadcast-end":
		if c.Room != nil {
			c.Room.Mu.Lock()
			if c.Room.ActiveBroadcaster == c {
				c.Room.ActiveBroadcaster = nil
				log.Printf("Client %s finished broadcast in room %s\n", c.ID, c.Room.ID)
				// Broadcast notification that broadcast ended
				c.Hub.broadcastToRoomExcept(c.Room, c.ID, Message{
					Type: "broadcast-ended",
				})
			}
			c.Room.Mu.Unlock()
		}
	}
}

// Helper to generate a random client/room ID.
func generateID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}
