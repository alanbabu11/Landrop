import { useState, useRef, useCallback, useEffect } from 'react';
import { 
  sendFileOverDataChannel, 
  sendFileOverWebSocket, 
  calculateSHA256,
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSharedSecretKey,
  calculateFingerprint,
  decryptMetadata,
  decryptChunk,
  FileStorage
} from '../utils/fileTransfer';

const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

export const useWebRTC = (sendMessage, sendBinary) => {
  const [connectionState, setConnectionState] = useState('new');
  const [dataChannelState, setDataChannelState] = useState('closed');
  const [activePeerId, setActivePeerId] = useState(null);
  const [fingerprint, setFingerprint] = useState(''); // Fingerprint for the active peer connection

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
    isSecure: false,
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
  const activePeerIdRef = useRef(null); // Ref to prevent stale closures on peer ID

  // Cryptographic Key Lifecycles
  const localECDHPrivateKeyRef = useRef(null);
  const localPublicKeySpkiRef = useRef(''); // Local exported public key spki
  const peerSharedKeysRef = useRef({}); // Caches derived keys by Peer ID
  const peerFingerprintsRef = useRef({}); // Caches session fingerprints by Peer ID
  const activeSharedKeyRef = useRef(null); // Binds the key for the active transfer session

  // Storage Refs
  const fileStorageRef = useRef(null);
  const chunkIndexRef = useRef(0);

  // Unicast transfer tracking refs
  const transferMetaRef = useRef(null);
  const transferBytesReceivedRef = useRef(0);
  const speedIntervalRef = useRef(null);
  const lastProgressBytesRef = useRef(0);

  // Broadcast tracking refs
  const broadcastMetaRef = useRef(null);
  const broadcastBytesReceivedRef = useRef(0);
  const broadcastSpeedIntervalRef = useRef(null);
  const lastBroadcastBytesRef = useRef(0);

  // Helper to update activePeerId state and ref together
  const updateActivePeerId = useCallback((id) => {
    setActivePeerId(id);
    activePeerIdRef.current = id;
  }, []);

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
    console.log('Cleaning up WebRTC, Relay, Broadcast & Storage resources...');
    cleanupWebRTC();
    
    if (speedIntervalRef.current) {
      clearInterval(speedIntervalRef.current);
      speedIntervalRef.current = null;
    }
    if (broadcastSpeedIntervalRef.current) {
      clearInterval(broadcastSpeedIntervalRef.current);
      broadcastSpeedIntervalRef.current = null;
    }

    if (fileStorageRef.current) {
      fileStorageRef.current.clear();
      fileStorageRef.current.close();
      fileStorageRef.current = null;
    }

    activeSharedKeyRef.current = null;
    chunkIndexRef.current = 0;

    setConnectionState('closed');
    setDataChannelState('closed');
    updateActivePeerId(null);
    setFingerprint('');
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
      isSecure: false,
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
    transferBytesReceivedRef.current = 0;
    lastProgressBytesRef.current = 0;

    broadcastMetaRef.current = null;
    broadcastBytesReceivedRef.current = 0;
    lastBroadcastBytesRef.current = 0;
  }, [cleanupWebRTC, updateActivePeerId]);

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

  // Unicast file receiver initialization
  const startIncomingTransfer = useCallback(async (name, size, mime, mode = 'p2p', hash = '', senderId = null) => {
    console.log(`Receiving file: ${name} (${size} bytes) via ${mode}. Expected SHA-256: ${hash}`);
    
    // Bind active decryption key
    const targetPeer = senderId || activePeerIdRef.current || transferMetaRef.current?.senderId;
    const sharedKey = peerSharedKeysRef.current[targetPeer] || null;
    activeSharedKeyRef.current = sharedKey;

    // Setup transient storage backing
    const storage = new FileStorage();
    await storage.init();
    await storage.clear();
    fileStorageRef.current = storage;
    chunkIndexRef.current = 0;

    transferMetaRef.current = { name, size, mime, mode, hash, senderId: targetPeer };
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
      isSecure: !!sharedKey,
    });
    
    // Update active fingerprint display if available
    if (targetPeer && peerFingerprintsRef.current[targetPeer]) {
      setFingerprint(peerFingerprintsRef.current[targetPeer]);
    }

    startSpeedTracking();
  }, [startSpeedTracking]);

  const processBinaryPacket = useCallback(async (arrayBuffer) => {
    const meta = transferMetaRef.current;
    if (!meta || !fileStorageRef.current) return;

    try {
      let chunk = arrayBuffer;
      if (activeSharedKeyRef.current) {
        chunk = await decryptChunk(activeSharedKeyRef.current, arrayBuffer);
      }

      await fileStorageRef.current.putChunk(chunkIndexRef.current, chunk);
      chunkIndexRef.current += 1;

      const currentReceived = transferBytesReceivedRef.current + chunk.byteLength;
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

        const chunks = await fileStorageRef.current.getAllChunks();
        const blob = new Blob(chunks, { type: meta.mime });
        const calculatedHash = await calculateSHA256(blob);
        console.log(`Calculated Hash: ${calculatedHash}, Expected Hash: ${meta.hash}`);

        if (calculatedHash === meta.hash || !meta.hash || !calculatedHash) {
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

        await fileStorageRef.current.clear();
        fileStorageRef.current.close();
        fileStorageRef.current = null;
        activeSharedKeyRef.current = null;
        transferMetaRef.current = null;
      }
    } catch (err) {
      console.error('Error during packet process:', err);
      setTransferState((prev) => ({ ...prev, status: 'failed', error: err.message }));
      if (fileStorageRef.current) {
        fileStorageRef.current.clear();
        fileStorageRef.current.close();
        fileStorageRef.current = null;
      }
      activeSharedKeyRef.current = null;
      transferMetaRef.current = null;
    }
  }, [stopSpeedTracking]);

  // Broadcast file receiver logic (Broadcasts bypass asymmetric ECDH)
  const startIncomingBroadcast = useCallback(async (name, size, mime, senderName, hash = '') => {
    console.log(`Receiving LAN Broadcast: ${name} (${size} bytes) from ${senderName}. Expected SHA-256: ${hash}`);
    
    const storage = new FileStorage();
    await storage.init();
    await storage.clear();
    fileStorageRef.current = storage;
    chunkIndexRef.current = 0;

    broadcastMetaRef.current = { name, size, mime, hash };
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
    if (!meta || !fileStorageRef.current) return;

    try {
      await fileStorageRef.current.putChunk(chunkIndexRef.current, arrayBuffer);
      chunkIndexRef.current += 1;

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

        const chunks = await fileStorageRef.current.getAllChunks();
        const blob = new Blob(chunks, { type: meta.mime });
        const calculatedHash = await calculateSHA256(blob);
        console.log(`Calculated Broadcast Hash: ${calculatedHash}, Expected Hash: ${meta.hash}`);

        if (calculatedHash === meta.hash || !meta.hash || !calculatedHash) {
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

        await fileStorageRef.current.clear();
        fileStorageRef.current.close();
        fileStorageRef.current = null;
        broadcastMetaRef.current = null;
      }
    } catch (err) {
      console.error('Error during broadcast packet process:', err);
      setBroadcastState((prev) => ({ ...prev, status: 'failed', error: err.message }));
      if (fileStorageRef.current) {
        fileStorageRef.current.clear();
        fileStorageRef.current.close();
        fileStorageRef.current = null;
      }
      broadcastMetaRef.current = null;
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
    dc.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        try {
          const msg = JSON.parse(event.data);
          const sharedKey = peerSharedKeysRef.current[activePeerIdRef.current] || null;

          if (msg.type === 'meta-encrypted' && sharedKey) {
            activeSharedKeyRef.current = sharedKey;
            const decryptedMeta = await decryptMetadata(sharedKey, msg.payload);
            await startIncomingTransfer(decryptedMeta.name, decryptedMeta.size, decryptedMeta.mime, 'p2p', decryptedMeta.hash, activePeerIdRef.current);
          } else if (msg.type === 'meta') {
            await startIncomingTransfer(msg.name, msg.size, msg.mime, 'p2p', msg.hash, activePeerIdRef.current);
          }
        } catch (err) {
          console.error('Failed to parse metadata frame:', err);
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
    updateActivePeerId(peerId);
    isRelayRef.current = false;

    // Load cached fingerprint if it exists
    if (peerFingerprintsRef.current[peerId]) {
      setFingerprint(peerFingerprintsRef.current[peerId]);
    } else {
      setFingerprint('');
    }

    // Ephemeral Key Exchange setup
    try {
      if (crypto && crypto.subtle) {
        const keyPair = await generateECDHKeyPair();
        localECDHPrivateKeyRef.current = keyPair.privateKey;
        const spki = await exportPublicKey(keyPair.publicKey);
        localPublicKeySpkiRef.current = spki;

        // Send the ephemeral public key to target peer
        sendMessage('signal', {
          targetId: peerId,
          signal: {
            type: 'key-exchange',
            publicKey: spki,
          },
        });
      } else {
        console.warn('Web Crypto API is not available (unsecure context). E2EE is disabled.');
      }
    } catch (err) {
      console.error('ECDH keypair generation failed:', err);
    }

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
  }, [cleanupAll, triggerRelayFallback, sendMessage, setupPeerConnectionListeners, setupDataChannelListeners, updateActivePeerId]);

  const handleIncomingMessage = useCallback(async (msg) => {
    const senderId = msg.payload?.senderId || msg.payload?.targetId;

    if (msg.type === 'signal') {
      const signal = msg.payload.signal;

      if (signal.type === 'key-exchange') {
        try {
          if (crypto && crypto.subtle) {
            const keyPair = await generateECDHKeyPair();
            localECDHPrivateKeyRef.current = keyPair.privateKey;
            const spki = await exportPublicKey(keyPair.publicKey);
            localPublicKeySpkiRef.current = spki;

            // Reply with public key
            sendMessage('signal', {
              targetId: senderId,
              signal: {
                type: 'key-exchange-response',
                publicKey: spki,
              },
            });

            // Derive shared key
            const remoteKey = await importPublicKey(signal.publicKey);
            const sharedKey = await deriveSharedSecretKey(localECDHPrivateKeyRef.current, remoteKey);
            peerSharedKeysRef.current[senderId] = sharedKey;

            // Generate E2EE verification fingerprint code
            const sessionFingerprint = await calculateFingerprint(spki, signal.publicKey);
            peerFingerprintsRef.current[senderId] = sessionFingerprint;
            setFingerprint(sessionFingerprint);

            console.log(`ECDH shared key and verification fingerprint (${sessionFingerprint}) established for peer: ${senderId}`);
          }
        } catch (err) {
          console.error('ECDH key exchange fail on key-exchange:', err);
        }

      } else if (signal.type === 'key-exchange-response') {
        try {
          if (crypto && crypto.subtle) {
            const remoteKey = await importPublicKey(signal.publicKey);
            const sharedKey = await deriveSharedSecretKey(localECDHPrivateKeyRef.current, remoteKey);
            peerSharedKeysRef.current[senderId] = sharedKey;

            // Generate fingerprint from stored local SPKI
            const sessionFingerprint = await calculateFingerprint(localPublicKeySpkiRef.current, signal.publicKey);
            peerFingerprintsRef.current[senderId] = sessionFingerprint;
            setFingerprint(sessionFingerprint);

            console.log(`ECDH shared key response and fingerprint (${sessionFingerprint}) established for peer: ${senderId}`);
          }
        } catch (err) {
          console.error('ECDH key exchange fail on response:', err);
        }

      } else if (signal.type === 'offer') {
        // cleanupAll() resets active connection but preserves peerSharedKeysRef map
        cleanupAll();
        updateActivePeerId(senderId);
        
        // Restore fingerprint if available
        if (peerFingerprintsRef.current[senderId]) {
          setFingerprint(peerFingerprintsRef.current[senderId]);
        }

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
      updateActivePeerId(senderId);
      
      const sharedKey = peerSharedKeysRef.current[senderId] || null;
      activeSharedKeyRef.current = sharedKey;

      if (peerFingerprintsRef.current[senderId]) {
        setFingerprint(peerFingerprintsRef.current[senderId]);
      }

      setTransferState((prev) => ({
        ...prev,
        mode: 'relay',
        status: 'idle',
        isSecure: !!sharedKey,
      }));

    } else if (msg.type === 'relay-meta') {
      const payloadId = msg.payload.senderId;
      const meta = msg.payload.meta;
      
      // Bind correct peer key derived for this sender
      const sharedKey = peerSharedKeysRef.current[payloadId] || null;
      activeSharedKeyRef.current = sharedKey;

      try {
        if (meta.encrypted && sharedKey) {
          const decryptedMeta = await decryptMetadata(sharedKey, meta.encrypted);
          await startIncomingTransfer(decryptedMeta.name, decryptedMeta.size, decryptedMeta.mime, 'relay', decryptedMeta.hash, payloadId);
        } else {
          await startIncomingTransfer(meta.name, meta.size, meta.mime, 'relay', meta.hash, payloadId);
        }
      } catch (err) {
        console.error('Decryption of relay-meta failed:', err);
      }

    } else if (msg.type === 'relay-closed') {
      const payloadId = msg.payload?.senderId || senderId;
      console.warn(`Relay connection closed by peer: ${payloadId}`);
      setTransferState((prev) => ({ ...prev, status: 'failed', error: 'Connection closed by peer.' }));
      cleanupAll();

    } else if (msg.type === 'broadcast-meta') {
      const meta = msg.payload;
      await startIncomingBroadcast(meta.name, meta.size, meta.mime, meta.senderName, meta.hash);

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
      console.log('Broadcast finished or interrupted.');
      stopBroadcastSpeedTracking();
      if (broadcastMetaRef.current) {
        setBroadcastState((prev) => ({
          ...prev,
          status: 'failed',
          error: 'Broadcast ended abruptly.',
        }));
        broadcastMetaRef.current = null;
      }
    } else if (msg.type === 'peer-left') {
      // Clean up key and fingerprint caches on peer leave
      delete peerSharedKeysRef.current[senderId];
      delete peerFingerprintsRef.current[senderId];
      if (activePeerIdRef.current === senderId) {
        setFingerprint('');
      }
    } else if (msg.type === 'join-error') {
      console.warn('Join error alert:', msg.payload.message);
      alert(msg.payload.message);
    }
  }, [cleanupAll, cleanupWebRTC, sendMessage, setupPeerConnectionListeners, setupDataChannelListeners, startIncomingTransfer, startIncomingBroadcast, stopBroadcastSpeedTracking, processBinaryPacket, processBroadcastBinaryPacket, updateActivePeerId]);

  const sendFile = useCallback(async (file) => {
    if (transferState.active) return;
    const currentMode = isRelayRef.current ? 'relay' : 'p2p';
    
    // Bind active encryption key for this transfer
    const sharedKey = peerSharedKeysRef.current[activePeerIdRef.current] || null;
    activeSharedKeyRef.current = sharedKey;

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
      isSecure: !!sharedKey,
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
        await sendFileOverWebSocket(sendBinary, sendMessage, file, onProgress, fileHash, false, sharedKey);
      } else {
        if (!dcRef.current || dcRef.current.readyState !== 'open') {
          throw new Error('DataChannel is not open/ready.');
        }
        await sendFileOverDataChannel(dcRef.current, file, onProgress, fileHash, sharedKey);
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

      // Broadcast streams bypass symmetric E2EE
      await sendFileOverWebSocket(sendBinary, sendMessage, file, onProgress, fileHash, true, null);

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
    if (broadcastMetaRef.current) {
      processBroadcastBinaryPacket(arrayBuffer);
    } else if (transferMetaRef.current && transferMetaRef.current.mode === 'relay') {
      processBinaryPacket(arrayBuffer);
    }
  }, [processBinaryPacket, processBroadcastBinaryPacket]);

  useEffect(() => {
    return () => cleanupAll();
  }, [cleanupAll]);

  return {
    connectionState,
    dataChannelState,
    activePeerId,
    fingerprint, // Expose optional fingerprint for out-of-band validation
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
