package main

import (
	"log"
	"net/http"

	"landrop-server/internal/ws"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Accept connections from any origin for simplicity during development/cross-device tests.
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func main() {
	r := gin.Default()

	// Setup CORS headers
	r.Use(func(c *gin.Context) {
		c.Writer.Header().Set("Access-Control-Allow-Origin", "*")
		c.Writer.Header().Set("Access-Control-Allow-Credentials", "true")
		c.Writer.Header().Set("Access-Control-Allow-Headers", "Content-Type, Content-Length, Accept-Encoding, X-CSRF-Token, Authorization, accept, origin, Cache-Control, X-Requested-With")
		c.Writer.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS, GET, PUT, DELETE")

		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	hub := ws.NewHub()

	r.GET("/ws", func(c *gin.Context) {
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("Failed to upgrade connection: %v\n", err)
			return
		}

		name := c.DefaultQuery("name", "Anonymous Device")
		device := c.DefaultQuery("device", "Unknown Device")
		ip := c.ClientIP()

		log.Printf("New connection request: Name: %s, Device: %s, IP: %s\n", name, device, ip)

		client := ws.NewClient(hub, conn, name, device, ip)

		// Start write pump in a separate goroutine.
		go client.WritePump()

		// Join the room identified by the client's public IP.
		hub.JoinRoom(ip, client)

		// Start read pump in the main goroutine (blocks until connection closes).
		client.ReadPump()
	})

	log.Println("LANDrop server running on :8080...")
	if err := r.Run(":8000"); err != nil {
		log.Fatalf("Server failed to run: %v\n", err)
	}
}
