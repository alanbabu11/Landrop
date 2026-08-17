import { useState, useRef, useCallback, useEffect } from 'react';
import { sendFileOverDataChannel, sendFileOverWebSocket, calculateSHA256 } from '../utils/fileTransfer';

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

export const useWebRTC = (sendMessage, sendBinary) => {
  const [connectionState, setConnectionState] = useState('new');
  const [dataChannelState, setDataChannelState] = useState('closed');
  const [activePeerId, setActivePeerId] = useState(null);

  // Unicast P2P/Relay transfer state
  const [transferState, setTransferState] = useState({
    active: false,
    name: '',
    size: 0,
    progress: 0,
    speed: 0,
    direction: null,
    status: 'idle', // 'idle' | 'hashing' | 'transferring' | 'verifying' | 'completed' | 'failed'
    mode: 'p2p',
    error: null,
  });

  // Broadcast transfer state
  const [broadcastState, setBroadcastState] = useState({
    active: false,
    name: '',
    size: 0,
    progress: 0,
    speed: 0,
    direction: null,
    status: 'idle', // 'idle' | 'hashing' | 'transferring' | 'verifying' | 'completed' | 'failed'
    senderName: '',
    error: null,
  });

  const pcRef = useRef(null);
  const dcRef = useRef(null);
  const connectionTimeoutRef = useRef(null);
  const isRelayRef = useRef(false);
  const remoteCandidatesQueue = useRef([]);

  // Unicast transfer tracking refs
  const transferMetaRef = useRef(null);
  const transferChunksRef = useRef([]);
  const transferBytesReceivedRef = useRef(0);
  const speedIntervalRef = useRef(null);
  const lastProgressBytesRef = useRef(0);

  // Broadcast tracking refs
  const broadcastMetaRef = useRef(null);
  const broadcastChunksRef = useRef([]);
  const broadcastBytesReceivedRef = useRef(0);
  const broadcastSpeedIntervalRef = useRef(null);
  const lastBroadcastBytesRef = useRef(0);

  const cleanupWebRTC = useCallback(() => {
    if (dcRef.current) {
      dcRef.current.close();
      dcRef.current = null;
    }
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
    }
    if (connectionTimeoutRef.current) {
      clearTimeout(connectionTimeoutRef.current);
      connectionTimeoutRef.current = null;
    }
  }, []);

  const cleanupAll = useCallback(() => {
    console.log('Cleaning up WebRTC, Relay & Broadcast resources...');
    cleanupWebRTC();
    
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
    }
    if (broadcastSpeedIntervalRef.current) {
      clearInterval(broadcastSpeedIntervalRef.current);
      broadcastSpeedIntervalRef.current = null;
    }

    setConnectionState('closed');
    setDataChannelState('closed');
    setActivePeerId(null);
    isRelayRef.current = false;
    remoteCandidatesQueue.current = [];

    setTransferState({
      active: false,
      name: '',
      size: 0,
      progress: 0,
      speed: 0,
      direction: null,
      status: 'idle',
      mode: 'p2p',
      error: null,
    });

    setBroadcastState({
      active: false,
      name: '',
      size: 0,
      progress: 0,
      speed: 0,
      direction: null,
      status: 'idle',
      senderName: '',
      error: null,
    });

    transferMetaRef.current = null;
    transferChunksRef.current = [];
    transferBytesReceivedRef.current = 0;
    lastProgressBytesRef.current = 0;

    broadcastMetaRef.current = null;
    broadcastChunksRef.current = [];
    broadcastBytesReceivedRef.current = 0;
    lastBroadcastBytesRef.current = 0;
  }, [cleanupWebRTC]);

  const startSpeedTracking = useCallback(() => {
    if (speedIntervalRef.current) clearInterval(speedIntervalRef.current);
    let lastBytes = 0;
    let lastTime = Date.now();
    speedIntervalRef.current = setInterval(() => {
      const now = Date.now();
      const timeDiff = (now - lastTime) / 1000;
      if (timeDiff <= 0) return;
      const currentBytes = lastProgressBytesRef.current;
      const deltaBytes = currentBytes - lastBytes;
      const speed = deltaBytes / timeDiff;
      lastBytes = currentBytes;
      lastTime = now;
      setTransferState((prev) => ({ ...prev, speed }));
    }, 1000);
  }, []);

  const stopSpeedTracking = useCallback(() => {
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
    }
  }, []);

  const startBroadcastSpeedTracking = useCallback(() => {
    if (broadcastSpeedIntervalRef.current) clearInterval(broadcastSpeedIntervalRef.current);
    let lastBytes = 0;
    let lastTime = Date.now();
    broadcastSpeedIntervalRef.current = setInterval(() => {
      const now = Date.now();
      const timeDiff = (now - lastTime) / 1000;
      if (timeDiff <= 0) return;
      const currentBytes = lastBroadcastBytesRef.current;
      const deltaBytes = currentBytes - lastBytes;
      const speed = deltaBytes / timeDiff;
      lastBytes = currentBytes;
      lastTime = now;
      setBroadcastState((prev) => ({ ...prev, speed }));
    }, 1000);
  }, []);

  const stopBroadcastSpeedTracking = useCallback(() => {
    if (broadcastSpeedIntervalRef.current) {
      clearInterval(broadcastSpeedIntervalRef.current);
      broadcastSpeedIntervalRef.current = null;
    }
  }, []);

  const setupPeerConnectionListeners = useCallback((pc, targetId) => {
    pc.onicecandidate = (event) => {
      if (event.candidate && !isRelayRef.current) {
        sendMessage('signal', {
          targetId,
          signal: {
            type: 'candidate',
            candidate: event.candidate,
          },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`WebRTC Connection State: ${pc.connectionState}`);
      setConnectionState(pc.connectionState);
      if (pc.connectionState === 'connected') {
        if (connectionTimeoutRef.current) {
          clearTimeout(connectionTimeoutRef.current);
          connectionTimeoutRef.current = null;
        }
      } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (!isRelayRef.current) {
          console.warn('WebRTC failed/closed. Checking fallback...');
          triggerRelayFallback(targetId);
        }
      }
    };
  }, [sendMessage]);

  // Unicast file receiver logic
  const startIncomingTransfer = useCallback((name, size, mime, mode = 'p2p', hash = '') => {
    console.log(`Receiving file: ${name} (${size} bytes) via ${mode}. Expected SHA-256: ${hash}`);
    transferMetaRef.current = { name, size, mime, mode, hash };
    transferChunksRef.current = [];
    transferBytesReceivedRef.current = 0;
    lastProgressBytesRef.current = 0;

    setTransferState({
      active: true,
      name,
      size,
      progress: 0,
      speed: 0,
      direction: 'receive',
      status: 'transferring',
      mode,
      error: null,
    });
    startSpeedTracking();
  }, [startSpeedTracking]);

  const processBinaryPacket = useCallback(async (arrayBuffer) => {
    const meta = transferMetaRef.current;
    if (!meta) return;

    transferChunksRef.current.push(arrayBuffer);
    const currentReceived = transferBytesReceivedRef.current + arrayBuffer.byteLength;
    transferBytesReceivedRef.current = currentReceived;
    lastProgressBytesRef.current = currentReceived;

    setTransferState((prev) => ({
      ...prev,
      progress: Math.min((currentReceived / meta.size) * 100, 100),
    }));

    if (currentReceived >= meta.size) {
      stopSpeedTracking();
      console.log('Unicast file data received. Verifying SHA-256 integrity...');

      setTransferState((prev) => ({ ...prev, status: 'verifying' }));

      try {
        const blob = new Blob(transferChunksRef.current, { type: meta.mime });
        const calculatedHash = await calculateSHA256(blob);
        console.log(`Calculated Hash: ${calculatedHash}, Expected Hash: ${meta.hash}`);

        if (calculatedHash === meta.hash) {
          console.log('Integrity verified successfully. Triggering download.');
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = meta.name;
          a.click();
          URL.revokeObjectURL(url);

          setTransferState((prev) => ({
            ...prev,
            status: 'completed',
            progress: 100,
          }));
        } else {
          console.error('Integrity verification failed! Hashes do not match.');
          setTransferState((prev) => ({
            ...prev,
            status: 'failed',
            error: 'Security Warning: Cryptographic check failed. File may be modified or corrupted.',
          }));
        }
      } catch (err) {
        console.error('Error during hashing:', err);
        setTransferState((prev) => ({ ...prev, status: 'failed', error: 'Hashing error occurred.' }));
      }

      transferMetaRef.current = null;
      transferChunksRef.current = [];
    }
  }, [stopSpeedTracking]);

  // Broadcast file receiver logic
  const startIncomingBroadcast = useCallback((name, size, mime, senderName, hash = '') => {
    console.log(`Receiving LAN Broadcast: ${name} (${size} bytes) from ${senderName}. Expected SHA-256: ${hash}`);
    broadcastMetaRef.current = { name, size, mime, hash };
    broadcastChunksRef.current = [];
    broadcastBytesReceivedRef.current = 0;
    lastBroadcastBytesRef.current = 0;

    setBroadcastState({
      active: true,
      name,
      size,
      progress: 0,
      speed: 0,
      direction: 'receive',
      status: 'transferring',
      senderName,
      error: null,
    });
    startBroadcastSpeedTracking();
  }, [startBroadcastSpeedTracking]);

  const processBroadcastBinaryPacket = useCallback(async (arrayBuffer) => {
    const meta = broadcastMetaRef.current;
    if (!meta) return;

    broadcastChunksRef.current.push(arrayBuffer);
    const currentReceived = broadcastBytesReceivedRef.current + arrayBuffer.byteLength;
    broadcastBytesReceivedRef.current = currentReceived;
    lastBroadcastBytesRef.current = currentReceived;

    setBroadcastState((prev) => ({
      ...prev,
      progress: Math.min((currentReceived / meta.size) * 100, 100),
    }));

    if (currentReceived >= meta.size) {
      stopBroadcastSpeedTracking();
      console.log('LAN Broadcast received. Verifying SHA-256 integrity...');

      setBroadcastState((prev) => ({ ...prev, status: 'verifying' }));

      try {
        const blob = new Blob(broadcastChunksRef.current, { type: meta.mime });
        const calculatedHash = await calculateSHA256(blob);
        console.log(`Calculated Broadcast Hash: ${calculatedHash}, Expected Hash: ${meta.hash}`);

        if (calculatedHash === meta.hash) {
          console.log('Broadcast integrity verified. Triggering download.');
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = meta.name;
          a.click();
          URL.revokeObjectURL(url);

          setBroadcastState((prev) => ({
            ...prev,
            status: 'completed',
            progress: 100,
          }));
        } else {
          console.error('Broadcast integrity verification failed! Hashes do not match.');
          setBroadcastState((prev) => ({
            ...prev,
            status: 'failed',
            error: 'Security Warning: Cryptographic check failed. File may be modified or corrupted.',
          }));
        }
      } catch (err) {
        console.error('Error during broadcast hashing:', err);
        setBroadcastState((prev) => ({ ...prev, status: 'failed', error: 'Hashing error occurred.' }));
      }

      broadcastMetaRef.current = null;
      broadcastChunksRef.current = [];
    }
  }, [stopBroadcastSpeedTracking]);

  const setupDataChannelListeners = useCallback((dc) => {
    dc.onopen = () => {
      console.log('WebRTC DataChannel OPEN.');
      setDataChannelState('open');
    };
    dc.onclose = () => {
      console.log('WebRTC DataChannel CLOSED.');
      setDataChannelState('closed');
    };
    dc.onmessage = (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'meta') {
            startIncomingTransfer(msg.name, msg.size, msg.mime, 'p2p', msg.hash);
          }
        } catch (err) {
          console.error('Failed to parse text metadata frame:', err);
        }
        return;
      }
      if (event.data instanceof ArrayBuffer) {
        processBinaryPacket(event.data);
      }
    };
  }, [startIncomingTransfer, processBinaryPacket]);

  const triggerRelayFallback = useCallback((targetId) => {
    if (isRelayRef.current) return;
    console.warn(`Attempting fallback relay handshaking with ${targetId}...`);
    isRelayRef.current = true;
    cleanupWebRTC();

    setTransferState((prev) => ({
      ...prev,
      mode: 'relay',
      status: 'connecting',
    }));
    sendMessage('relay-request', { targetId });
  }, [sendMessage, cleanupWebRTC]);

  const connectToPeer = useCallback(async (peerId) => {
    cleanupAll();
    console.log(`Connecting to peer: ${peerId}`);
    setActivePeerId(peerId);
    isRelayRef.current = false;

    connectionTimeoutRef.current = setTimeout(() => {
      if (pcRef.current && pcRef.current.connectionState !== 'connected') {
        console.warn('WebRTC handshake timed out (7s). Triggering fallback.');
        triggerRelayFallback(peerId);
      }
    }, 7000);

    const pc = new RTCPeerConnection(rtcConfig);
    pcRef.current = pc;
    setupPeerConnectionListeners(pc, peerId);

    const dc = pc.createDataChannel('fileTransfer', { ordered: true });
    dcRef.current = dc;
    setupDataChannelListeners(dc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendMessage('signal', {
        targetId: peerId,
        signal: {
          type: 'offer',
          sdp: offer.sdp,
        },
      });
    } catch (err) {
      console.error('Failed to start WebRTC offer:', err);
      triggerRelayFallback(peerId);
    }
  }, [cleanupAll, triggerRelayFallback, sendMessage, setupPeerConnectionListeners, setupDataChannelListeners]);

  const handleIncomingMessage = useCallback(async (msg) => {
    const senderId = msg.payload?.senderId || msg.payload?.targetId;

    if (msg.type === 'signal') {
      const signal = msg.payload.signal;
      if (signal.type === 'offer') {
        cleanupAll();
        setActivePeerId(senderId);
        const pc = new RTCPeerConnection(rtcConfig);
        pcRef.current = pc;
        setupPeerConnectionListeners(pc, senderId);
        pc.ondatachannel = (event) => {
          const dc = event.channel;
          dcRef.current = dc;
          setupDataChannelListeners(dc);
        };
        try {
          await pc.setRemoteDescription(new RTCSessionDescription({
            type: 'offer',
            sdp: signal.sdp,
          }));
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendMessage('signal', {
            targetId: senderId,
            signal: {
              type: 'answer',
              sdp: answer.sdp,
            },
          });
          while (remoteCandidatesQueue.current.length > 0) {
            const cand = remoteCandidatesQueue.current.shift();
            await pc.addIceCandidate(new RTCIceCandidate(cand));
          }
        } catch (err) {
          console.error('Receiver handshake failed:', err);
        }
      } else if (signal.type === 'answer') {
        const pc = pcRef.current;
        if (pc) {
          try {
            await pc.setRemoteDescription(new RTCSessionDescription({
              type: 'answer',
              sdp: signal.sdp,
            }));
            while (remoteCandidatesQueue.current.length > 0) {
              const cand = remoteCandidatesQueue.current.shift();
              await pc.addIceCandidate(new RTCIceCandidate(cand));
            }
          } catch (err) {
            console.error('Setting remote answer failed:', err);
          }
        }
      } else if (signal.type === 'candidate') {
        const pc = pcRef.current;
        if (pc && pc.remoteDescription && pc.remoteDescription.type) {
          try {
            await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
          } catch (err) {
            console.error('Failed to add ICE candidate:', err);
          }
        } else {
          remoteCandidatesQueue.current.push(signal.candidate);
        }
      }

    } else if (msg.type === 'relay-ready') {
      console.log(`Relay setup ready. Role: ${msg.payload.role}`);
      isRelayRef.current = true;
      cleanupWebRTC();
      setActivePeerId(senderId);
      setTransferState((prev) => ({
        ...prev,
        mode: 'relay',
        status: 'idle',
      }));

    } else if (msg.type === 'relay-meta') {
      const meta = msg.payload;
      startIncomingTransfer(meta.name, meta.size, meta.mime, 'relay', meta.hash);

    } else if (msg.type === 'relay-closed') {
      console.warn('Relay partner closed connection.');
      setTransferState((prev) => ({ ...prev, status: 'failed' }));
      cleanupAll();

    } else if (msg.type === 'broadcast-meta') {
      const meta = msg.payload;
      startIncomingBroadcast(meta.name, meta.size, meta.mime, meta.senderName, meta.hash);

    } else if (msg.type === 'broadcast-error') {
      console.error('Broadcast blocked by server:', msg.payload.message);
      stopBroadcastSpeedTracking();
      setBroadcastState((prev) => ({
        ...prev,
        status: 'failed',
        error: msg.payload.message,
      }));
      broadcastMetaRef.current = null;

    } else if (msg.type === 'broadcast-ended') {
      console.log('Broadcast finished or interrupted by sender.');
      stopBroadcastSpeedTracking();
      if (broadcastMetaRef.current) {
        setBroadcastState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'Broadcast ended abruptly by sender.',
        }));
        broadcastMetaRef.current = null;
        broadcastChunksRef.current = [];
      }
    }
  }, [cleanupAll, cleanupWebRTC, sendMessage, setupPeerConnectionListeners, setupDataChannelListeners, startIncomingTransfer, startIncomingBroadcast, stopBroadcastSpeedTracking, processBinaryPacket, processBroadcastBinaryPacket]);

  const sendFile = useCallback(async (file) => {
    if (transferState.active) return;
    const currentMode = isRelayRef.current ? 'relay' : 'p2p';
    setTransferState({
      active: true,
      name: file.name,
      size: file.size,
      progress: 0,
      speed: 0,
      direction: 'send',
      status: 'hashing',
      mode: currentMode,
      error: null,
    });

    try {
      console.log('Calculating cryptographic hash...');
      const fileHash = await calculateSHA256(file);
      console.log(`SHA-256 Calculated: ${fileHash}`);

      setTransferState((prev) => ({ ...prev, status: 'transferring' }));
      lastProgressBytesRef.current = 0;
      startSpeedTracking();

      const onProgress = (offset, size) => {
        setTransferState((prev) => ({
          ...prev,
          progress: Math.min((offset / size) * 100, 100),
        }));
        lastProgressBytesRef.current = offset;
      };

      if (currentMode === 'relay') {
        await sendFileOverWebSocket(sendBinary, sendMessage, file, onProgress, fileHash);
      } else {
        if (!dcRef.current || dcRef.current.readyState !== 'open') {
          throw new Error('DataChannel is not open/ready.');
        }
        await sendFileOverDataChannel(dcRef.current, file, onProgress, fileHash);
      }
      stopSpeedTracking();
      setTransferState((prev) => ({ ...prev, status: 'completed', progress: 100 }));
    } catch (err) {
      console.error('File transfer failed:', err);
      stopSpeedTracking();
      setTransferState((prev) => ({ ...prev, status: 'failed', error: err.message }));
    }
  }, [transferState.active, sendMessage, sendBinary, startSpeedTracking, stopSpeedTracking]);

  const broadcastFile = useCallback(async (file) => {
    if (broadcastState.active) {
      console.warn('A broadcast is already running.');
      return;
    }

    setBroadcastState({
      active: true,
      name: file.name,
      size: file.size,
      progress: 0,
      speed: 0,
      direction: 'send',
      status: 'hashing',
      senderName: 'You',
      error: null,
    });

    try {
      console.log('Calculating broadcast cryptographic hash...');
      const fileHash = await calculateSHA256(file);
      console.log(`SHA-256 Calculated: ${fileHash}`);

      setBroadcastState((prev) => ({ ...prev, status: 'transferring' }));
      broadcastMetaRef.current = { name: file.name, size: file.size, mime: file.type };
      lastBroadcastBytesRef.current = 0;
      startBroadcastSpeedTracking();

      const onProgress = (offset, size) => {
        setBroadcastState((prev) => ({
          ...prev,
          progress: Math.min((offset / size) * 100, 100),
        }));
        lastBroadcastBytesRef.current = offset;
      };

      await sendFileOverWebSocket(sendBinary, sendMessage, file, onProgress, fileHash, true);

      sendMessage('broadcast-end', {});
      stopBroadcastSpeedTracking();

      setBroadcastState((prev) => ({
        ...prev,
        status: 'completed',
        progress: 100,
      }));
      broadcastMetaRef.current = null;
    } catch (err) {
      console.error('Broadcast transmission error:', err);
      stopBroadcastSpeedTracking();
      setBroadcastState((prev) => ({
        ...prev,
        status: 'failed',
        error: err.message,
      }));
    }
  }, [broadcastState.active, sendMessage, sendBinary, startBroadcastSpeedTracking, stopBroadcastSpeedTracking]);

  const handleIncomingBinary = useCallback((arrayBuffer) => {
    if (transferMetaRef.current && transferMetaRef.current.mode === 'relay') {
      processBinaryPacket(arrayBuffer);
    } else if (broadcastMetaRef.current) {
      processBroadcastBinaryPacket(arrayBuffer);
    }
  }, [processBinaryPacket, processBroadcastBinaryPacket]);

  useEffect(() => {
    return () => cleanupAll();
  }, [cleanupAll]);

  return {
    connectionState,
    dataChannelState,
    activePeerId,
    transferState,
    broadcastState,
    connectToPeer,
    handleIncomingMessage,
    handleIncomingBinary,
    sendFile,
    broadcastFile,
    disconnect: cleanupAll,
  };
};
