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
  
  const clientName = useRef(getRandomName());
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

  const connect = useCallback(() => {
    setSocketStatus('connecting');
    const wsUrl = `${serverUrl}?name=${encodeURIComponent(clientName.current)}&device=${encodeURIComponent(deviceDetails.current)}`;
    console.log(`Connecting to WebSocket at: ${wsUrl}`);
    
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer'; // Setup binary frames directly as ArrayBuffer
    socketRef.current = ws;

    ws.onopen = () => {
      console.log('WebSocket connection established.');
      setSocketStatus('connected');
    };

    ws.onmessage = (event) => {
      // Route raw binary frames to the binary handler callback
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
              setPeers(msg.payload.peers || []);
              break;
              
            case 'peer-joined':
              setPeers((prev) => {
                if (prev.some((p) => p.id === msg.payload.id)) return prev;
                return [...prev, msg.payload];
              });
              break;
              
            case 'peer-left':
              setPeers((prev) => prev.filter((p) => p.id !== msg.payload.id));
              break;
              
            default:
              // Forward other signaling/relay events to the message handler
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
    };

    ws.onerror = (err) => {
      console.error('WebSocket encountered an error:', err);
      setSocketStatus('disconnected');
    };
  }, [serverUrl, onMessageReceived, onBinaryReceived]);

  useEffect(() => {
    connect();
    return () => {
      if (socketRef.current) {
        socketRef.current.close();
      }
    };
  }, [connect]);

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
