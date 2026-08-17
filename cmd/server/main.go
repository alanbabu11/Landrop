package main

import (
	"log"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"landrop-server/internal/ws"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var (
	connMutex      sync.Mutex
	ipConnections  = make(map[string][]time.Time)
	allowedOrigins []string
)

func init() {
	originsEnv := os.Getenv("ALLOWED_WS_ORIGINS")
	if originsEnv != "" {
		for _, org := range strings.Split(originsEnv, ",") {
			trimmed := strings.TrimSpace(org)
			if trimmed != "" {
				allowedOrigins = append(allowedOrigins, trimmed)
			}
		}
		log.Printf("Configured allowed WebSocket origins: %v\n", allowedOrigins)
	}
}

// Rate limit check: max 5 connections per 10 seconds per IP
func rateLimitCheck(ip string) bool {
	connMutex.Lock()
	defer connMutex.Unlock()

	now := time.Now()
	cutoff := now.Add(-10 * time.Second)

	// Filter out expired connection timestamps
	var active []time.Time
	for _, t := range ipConnections[ip] {
		if t.After(cutoff) {
			active = append(active, t)
		}
	}

	if len(active) >= 5 {
		return false
	}

	active = append(active, now)
	ipConnections[ip] = active
	return true
}

func isAllowedOrigin(origin string) bool {
	if origin == "" {
		// Reject empty origin in production if an explicit allowlist is configured
		return len(allowedOrigins) == 0
	}

	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	host := u.Hostname()

	// Always allow localhost and local LAN IPs for cross-device development/testing
	if host == "localhost" || host == "127.0.0.1" || strings.HasPrefix(host, "192.168.") || strings.HasPrefix(host, "10.") || strings.HasPrefix(host, "172.16.") {
		return true
	}

	// Check environment variable allowlist
	for _, allowed := range allowedOrigins {
		if u.String() == allowed || host == allowed || strings.HasSuffix(host, "."+allowed) {
			return true
		}
	}

	// If no ALLOWED_WS_ORIGINS is configured, default to allowing pages.dev subdomains
	if len(allowedOrigins) == 0 {
		return strings.HasSuffix(host, ".pages.dev")
	}

	return false
}

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Validate origin to prevent CSRF / unauthorized connection hijacking
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return isAllowedOrigin(origin)
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
		ip := c.ClientIP()
		if !rateLimitCheck(ip) {
			log.Printf("Rate limit exceeded for IP: %s\n", ip)
			c.String(http.StatusTooManyRequests, "Too many requests. Please try again later.")
			return
		}

		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("Failed to upgrade connection: %v\n", err)
			return
		}

		name := c.DefaultQuery("name", "Anonymous Device")
		device := c.DefaultQuery("device", "Unknown Device")

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
