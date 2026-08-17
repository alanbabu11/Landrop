import { useState, useEffect, useRef, useCallback } from 'react';

const getRandomName = () => {
  const adjectives = ['Cosmic', 'Nebula', 'Quantum', 'Glitch', 'Cyber', 'Solar', 'Hydra', 'Vortex', 'Neon', 'Lunar'];
  const nouns = ['Pioneer', 'Wanderer', 'Stalker', 'Ranger', 'Specter', 'Drifter', 'Falcon', 'Titan', 'Echo', 'Phoenix'];
  return `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
};

const getDeviceDetails = () => {
  const ua = navigator.userAgent;
  let browser = 'Web Browser';
  let os = 'Unknown OS';

  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';
  else if (ua.includes('Edge')) browser = 'Edge';

  if (ua.includes('Macintosh') || ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Linux')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

  return { browser, os, summary: `${browser} on ${os}` };
};

export const useWebSocket = (serverUrl, onMessageReceived, onBinaryReceived) => {
  const [socketStatus, setSocketStatus] = useState('connecting');
  const [roomId, setRoomId] = useState('');
  const [peers, setPeers] = useState([]);
  
  const socketRef = useRef(null);
  const reconnectCountRef = useRef(0);
  const reconnectTimeoutRef = useRef(null);
  const currentRoomCodeRef = useRef('');
  const isExplicitCloseRef = useRef(false);
  const myClientIdRef = useRef(null); // Ref to track own WebSocket connection ID

  const clientName = useRef(localStorage.getItem('landrop_username') || getRandomName());
  const deviceDetails = useRef(getDeviceDetails().summary);

  const sendMessage = useCallback((type, payload) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({ type, payload }));
    } else {
      console.warn('Cannot send message, WebSocket is not open.');
    }
  }, []);

  const sendBinary = useCallback((data) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(data);
    } else {
      console.warn('Cannot send binary frame, WebSocket is not open.');
    }
  }, []);

  const disconnectSocket = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (socketRef.current) {
      socketRef.current.onopen = null;
      socketRef.current.onmessage = null;
      socketRef.current.onclose = null;
      socketRef.current.onerror = null;
      socketRef.current.close();
      socketRef.current = null;
    }
  }, []);

  const connect = useCallback(() => {
    disconnectSocket();
    
    console.log(`Connecting to WebSocket server: ${serverUrl}`);
    const ws = new WebSocket(`${serverUrl}?name=${encodeURIComponent(clientName.current)}&device=${encodeURIComponent(deviceDetails.current)}`);
    ws.binaryType = 'arraybuffer';
    socketRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connection established.');
      setSocketStatus('connected');
      reconnectCountRef.current = 0;

      // Rejoin previous room if we got disconnected from a custom room channel
      if (currentRoomCodeRef.current) {
        console.log(`Auto-rejoining room channel: ${currentRoomCodeRef.current}`);
        ws.send(JSON.stringify({
          type: 'join-room',
          payload: { code: currentRoomCodeRef.current }
        }));
      }
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        if (onBinaryReceived) {
          onBinaryReceived(event.data);
        }
        return;
      }

      try {
        const rawMessages = event.data.split('\n');
        for (const rawMsg of rawMessages) {
          if (!rawMsg.trim()) continue;
          const msg = JSON.parse(rawMsg);
          
          switch (msg.type) {
            case 'room-info':
              setRoomId(msg.payload.room);
              const myId = msg.payload.myId;
              myClientIdRef.current = myId;
              // Filter out own ID if it leaked inside peers list
              setPeers((msg.payload.peers || []).filter((p) => p.id !== myId));
              currentRoomCodeRef.current = msg.payload.room;
              break;
              
            case 'peer-joined':
              setPeers((prev) => {
                if (msg.payload.id === myClientIdRef.current) return prev; // Do not discover self
                if (prev.some((p) => p.id === msg.payload.id)) return prev;
                return [...prev, msg.payload];
              });
              break;
              
            case 'peer-left':
              setPeers((prev) => prev.filter((p) => p.id !== msg.payload.id));
              break;
              
            default:
              if (onMessageReceived) {
                onMessageReceived(msg);
              }
          }
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err, event.data);
      }
    };

    ws.onclose = (event) => {
      console.log('WebSocket connection closed:', event.reason);
      setSocketStatus('disconnected');
      if (!isExplicitCloseRef.current) {
        triggerReconnection();
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket encountered an error:', err);
      setSocketStatus('disconnected');
    };
  }, [serverUrl, onMessageReceived, onBinaryReceived, disconnectSocket]);

  const triggerReconnection = useCallback(() => {
    if (reconnectTimeoutRef.current) return;
    
    const delay = Math.min(1000 * Math.pow(2, reconnectCountRef.current), 16000);
    console.log(`Scheduling auto-reconnect in ${delay}ms (attempt ${reconnectCountRef.current + 1})...`);
    
    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectCountRef.current += 1;
      reconnectTimeoutRef.current = null;
      connect();
    }, delay);
  }, [connect]);

  useEffect(() => {
    isExplicitCloseRef.current = false;
    connect();
    return () => {
      isExplicitCloseRef.current = true;
      disconnectSocket();
    };
  }, [connect, disconnectSocket]);

  const joinRoom = useCallback((code) => {
    sendMessage('join-room', { code });
  }, [sendMessage]);

  return {
    socketStatus,
    roomId,
    peers,
    sendMessage,
    sendBinary,
    joinRoom,
    myName: clientName.current,
    myDevice: deviceDetails.current,
  };
};
