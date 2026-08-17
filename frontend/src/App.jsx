import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useWebSocket } from './hooks/useWebSocket';
import { useWebRTC } from './hooks/useWebRTC';
import { Landing } from './pages/Landing';
import { Room } from './pages/Room';
import './App.css';

function App() {
  const [activePeer, setActivePeer] = useState(null);
  const signalCallbackRef = useRef(null);

  // Retrieve username from localStorage or start empty to trigger the welcome screen
  const [username, setUsername] = useState(localStorage.getItem('landrop-username') || '');

  const handleSignalReceived = useCallback((msg) => {
    if (signalCallbackRef.current) {
      signalCallbackRef.current(msg);
    }
  }, []);

  // Determine WebSocket backend URL dynamically to support cross-device testing on local LAN
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const backendHost = window.location.hostname === 'localhost' ? 'localhost:8000' : `${window.location.hostname}:8000`;
  const wsUrl = `${wsProtocol}//${backendHost}/ws`;

  // Ref to hold handleIncomingBinary to avoid dependency cycles
  const binaryCallbackRef = useRef(null);
  const handleBinaryReceived = useCallback((arrayBuffer) => {
    if (binaryCallbackRef.current) {
      binaryCallbackRef.current(arrayBuffer);
    }
  }, []);

  const {
    socketStatus,
    roomId,
    peers,
    sendMessage,
    sendBinary,
    joinRoom,
    myName,
    myDevice,
  } = useWebSocket(wsUrl, username, handleSignalReceived, handleBinaryReceived);

  const {
    connectionState,
    activePeerId,
    transferState,
    broadcastState,
    connectToPeer,
    handleIncomingMessage,
    handleIncomingBinary,
    sendFile,
    broadcastFile,
    disconnect,
  } = useWebRTC(sendMessage, sendBinary);

  // Bind the WebRTC signal handler to the WebSocket receiver
  useEffect(() => {
    signalCallbackRef.current = handleIncomingMessage;
    return () => {
      signalCallbackRef.current = null;
    };
  }, [handleIncomingMessage]);

  // Bind the WebRTC binary handler to the WebSocket binary receiver
  useEffect(() => {
    binaryCallbackRef.current = handleIncomingBinary;
    return () => {
      binaryCallbackRef.current = null;
    };
  }, [handleIncomingBinary]);

  // Synchronize activePeer state when WebRTC triggers a connection or disconnection
  useEffect(() => {
    if (activePeerId) {
      const peer = peers.find((p) => p.id === activePeerId);
      if (peer) {
        setActivePeer(peer);
      }
    } else {
      setActivePeer(null);
    }
  }, [activePeerId, peers]);

  const handleSelectPeer = (peer) => {
    setActivePeer(peer);
    connectToPeer(peer.id);
  };

  const handleDisconnect = () => {
    disconnect();
    setActivePeer(null);
  };

  const handleUpdateName = (newName) => {
    const trimmed = newName.trim();
    if (trimmed) {
      localStorage.setItem('landrop-username', trimmed);
      setUsername(trimmed);
    }
  };

  return (
    <div className="app-layout">
      {activePeer ? (
        <Room
          peer={activePeer}
          connectionState={connectionState}
          transferState={transferState}
          onDisconnect={handleDisconnect}
          onSendFile={sendFile}
        />
      ) : (
        <Landing
          roomId={roomId}
          peers={peers}
          joinRoom={joinRoom}
          onSelectPeer={handleSelectPeer}
          socketStatus={socketStatus}
          myName={username}
          myDevice={myDevice}
          broadcastState={broadcastState}
          onBroadcastFile={broadcastFile}
          onUpdateName={handleUpdateName}
        />
      )}
    </div>
  );
}

export default App;
