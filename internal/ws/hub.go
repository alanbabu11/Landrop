package ws

import (
	"encoding/json"
	"log"
	"sync"
)

// Room represents a grouping of clients sharing the same IP or code.
type Room struct {
	ID                string
	Clients           map[string]*Client
	ActiveBroadcaster *Client // Tracks the device currently broadcasting to the room
	// Mutex protects the Clients map and ActiveBroadcaster pointer from concurrent access
	Mu sync.RWMutex
}

// Hub manages all active rooms and handles client dispatch.
type Hub struct {
	Rooms map[string]*Room
	// Mutex protects the Rooms map from concurrent read/write operations
	// (e.g. when creating or destroying rooms simultaneously).
	Mu sync.RWMutex
}

// NewHub initializes and returns a new Hub.
func NewHub() *Hub {
	return &Hub{
		Rooms: make(map[string]*Room),
	}
}

// GetOrCreateRoom finds or creates a room by ID.
func (h *Hub) GetOrCreateRoom(roomID string) *Room {
	// Acquire Write Lock because we might mutate the Rooms map.
	h.Mu.Lock()
	defer h.Mu.Unlock()

	room, exists := h.Rooms[roomID]
	if !exists {
		room = &Room{
			ID:      roomID,
			Clients: make(map[string]*Client),
		}
		h.Rooms[roomID] = room
		log.Printf("Room %s created\n", roomID)
	}
	return room
}

// JoinRoom adds a client to a room and broadcasts their arrival.
func (h *Hub) JoinRoom(roomID string, client *Client) {
	// First, check if client is already in a room and leave it.
	if client.Room != nil {
		h.LeaveRoom(client)
	}

	room := h.GetOrCreateRoom(roomID)

	// Acquire Write Lock for room clients because we are adding a client to the map.
	room.Mu.Lock()
	if len(room.Clients) >= 50 {
		room.Mu.Unlock()
		log.Printf("JoinRoom rejected: Room %s capacity limit exceeded\n", roomID)
		client.SendJSON(Message{
			Type: "join-error",
			Payload: map[string]interface{}{
				"message": "Room capacity limit reached (max 50 devices).",
			},
		})
		return
	}
	room.Clients[client.ID] = client
	client.Room = room
	room.Mu.Unlock()

	log.Printf("Client %s joined room %s\n", client.ID, roomID)

	// Notify other clients in the room about the new peer
	h.broadcastToRoomExcept(room, client.ID, Message{
		Type: "peer-joined",
		Payload: map[string]interface{}{
			"id":     client.ID,
			"name":   client.Name,
			"device": client.Device,
		},
	})

	// Send current room information and other peers to the client that just joined
	var peers []map[string]interface{}
	room.Mu.RLock()
	for _, c := range room.Clients {
		if c.ID != client.ID {
			peers = append(peers, map[string]interface{}{
				"id":     c.ID,
				"name":   c.Name,
				"device": c.Device,
			})
		}
	}
	room.Mu.RUnlock()

	client.SendJSON(Message{
		Type: "room-info",
		Payload: map[string]interface{}{
			"room":  room.ID,
			"peers": peers,
			"myId":  client.ID,
		},
	})
}

// LeaveRoom removes a client from their current room and cleans up if the room becomes empty.
func (h *Hub) LeaveRoom(client *Client) {
	room := client.Room
	if room == nil {
		return
	}

	// Acquire Write Lock because we are deleting a client from the map.
	room.Mu.Lock()
	delete(room.Clients, client.ID)
	client.Room = nil
	clientCount := len(room.Clients)

	// Clean up any active relay partnerships for the leaving client
	if client.RelayPartner != nil {
		client.RelayPartner.SendJSON(Message{
			Type: "relay-closed",
			Payload: map[string]interface{}{
				"senderId": client.ID,
			},
		})
		client.RelayPartner.RelayPartner = nil
		client.RelayPartner = nil
	}

	// Clean up active broadcast if leaving client is the broadcaster
	wasBroadcaster := false
	if room.ActiveBroadcaster != nil && room.ActiveBroadcaster.ID == client.ID {
		room.ActiveBroadcaster = nil
		wasBroadcaster = true
	}
	room.Mu.Unlock()

	// Notify remaining clients that the broadcaster disconnected if they were active
	if wasBroadcaster {
		h.broadcastToRoomExcept(room, client.ID, Message{Type: "broadcast-ended"})
	}

	log.Printf("Client %s left room %s\n", client.ID, room.ID)

	// Notify remaining clients
	h.broadcastToRoomExcept(room, client.ID, Message{
		Type: "peer-left",
		Payload: map[string]interface{}{
			"id": client.ID,
		},
	})

	// If room is empty, delete the room from the hub to free memory.
	if clientCount == 0 {
		h.Mu.Lock()
		delete(h.Rooms, room.ID)
		h.Mu.Unlock()
		log.Printf("Room %s deleted (empty)\n", room.ID)
	}
}

// broadcastToRoomExcept sends a message to all clients in a room except the specified client ID.
func (h *Hub) broadcastToRoomExcept(room *Room, exceptID string, msg Message) {
	// Acquire Read Lock because we are iterating over room clients.
	room.Mu.RLock()
	defer room.Mu.RUnlock()

	payloadBytes, err := json.Marshal(msg)
	if err != nil {
		log.Printf("Failed to marshal broadcast message: %v\n", err)
		return
	}

	for _, client := range room.Clients {
		if client.ID != exceptID {
			// Enqueue message to client's write channel
			select {
			case client.Send <- WSMessage{Type: 1, Data: payloadBytes}: // 1 = websocket.TextMessage
			default:
				// If send channel is full/blocked, disconnect client
				log.Printf("Client %s write queue full, closing connection\n", client.ID)
				client.Conn.Close()
			}
		}
	}
}
