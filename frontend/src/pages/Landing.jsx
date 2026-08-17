import React, { useState, useRef } from 'react';
import { Monitor, Smartphone, Laptop, Radio, ArrowRight, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react';
import { formatSize, formatSpeed } from '../utils/fileTransfer';

const getDeviceIcon = (deviceStr) => {
  const ds = deviceStr.toLowerCase();
  if (ds.includes('phone') || ds.includes('ios') || ds.includes('android')) return <Smartphone size={24} />;
  if (ds.includes('mac') || ds.includes('windows') || ds.includes('linux')) return <Laptop size={24} />;
  return <Monitor size={24} />;
};

const isIP = (str) => {
  if (!str) return false;
  const ipv4Regex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
  const ipv6Regex = /:/;
  return ipv4Regex.test(str) || ipv6Regex.test(str);
};

const maskIP = (ip) => {
  if (!ip) return '';
  if (ip.includes(':')) {
    const parts = ip.split(':');
    return `${parts[0]}:••••:••••:••••:••••`;
  }
  const parts = ip.split('.');
  if (parts.length === 4) {
    return `${parts[0]}.${parts[1]}.•••.•••`;
  }
  return 'Local Network (IP Masked)';
};

export const Landing = ({
  roomId,
  peers,
  joinRoom,
  onSelectPeer,
  socketStatus,
  myName,
  myDevice,
  broadcastState,
  onBroadcastFile,
}) => {
  const [manualCode, setManualCode] = useState('');
  const broadcastInputRef = useRef(null);

  const handleJoinCodeSubmit = (e) => {
    e.preventDefault();
    if (manualCode.trim()) {
      joinRoom(manualCode.trim());
      setManualCode('');
    }
  };

  const handleBroadcastChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      onBroadcastFile(e.target.files[0]);
    }
  };

  const handleCreateRoom = () => {
    // Generate random secure 6-digit room code
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    joinRoom(code);
  };

  const handleLeavePrivateRoom = () => {
    // Send empty code to rejoin IP-based local network room
    joinRoom('');
  };

  const inPrivateRoom = !isIP(roomId);

  return (
    <div className="glass-container glow-effect">
      <div className="header">
        <div className="logo-container">
          <Radio className="text-secondary animate-pulse" size={28} />
          <span className="logo-text">LANDrop</span>
        </div>
        <div className="connection-status">
          <div className={`status-dot ${socketStatus}`} />
          <span style={{ textTransform: 'capitalize' }}>{socketStatus}</span>
        </div>
      </div>

      <div style={{ marginBottom: '2rem' }}>
        <p style={{ fontSize: '0.9rem', color: 'var(--text-secondary)' }}>You are visible as:</p>
        <h3 style={{ fontSize: '1.25rem', fontWeight: '700', color: 'var(--text-primary)', marginTop: '0.25rem' }}>
          {myName}
        </h3>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{myDevice}</p>
      </div>

      <div className="room-display">
        <div>
          <span className="room-display-label">
            {inPrivateRoom ? 'Private Channel Code:' : 'Current Room (Local Network):'}
          </span>
          <div className="room-display-code" style={{ fontFamily: inPrivateRoom ? 'monospace' : 'inherit', letterSpacing: inPrivateRoom ? '0.05rem' : 'normal' }}>
            {roomId ? (isIP(roomId) ? maskIP(roomId) : roomId) : 'Fetching...'}
          </div>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', maxWidth: '55%' }}>
          {inPrivateRoom 
            ? 'You are in a private channel. Share this room code with others to connect only with them.'
            : 'Devices on the same local network discover each other automatically.'}
        </p>
      </div>

      {/* Broadcast Progress Panel */}
      {broadcastState.active && (
        <div className="transfer-panel" style={{ marginTop: '2rem', border: '1px solid var(--secondary)', boxShadow: '0 0 15px var(--secondary-glow)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.0rem' }}>
            <Radio className="text-secondary animate-pulse" size={24} />
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              <p style={{ fontWeight: '600', fontSize: '0.95rem' }}>
                {broadcastState.direction === 'send' 
                  ? 'Broadcasting to Room: ' 
                  : `Incoming Broadcast from ${broadcastState.senderName}: `}
                {broadcastState.name}
              </p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{formatSize(broadcastState.size)}</p>
            </div>
            {broadcastState.status === 'completed' && <CheckCircle2 style={{ color: '#00ff66' }} size={24} />}
            {broadcastState.status === 'failed' && <AlertCircle style={{ color: '#ff3b30' }} size={24} />}
          </div>
          
          <div className="transfer-header">
            <span style={{ textTransform: 'capitalize' }}>
              {broadcastState.status === 'transferring'
                ? `${broadcastState.direction === 'send' ? 'Sending' : 'Receiving'} LAN broadcast...`
                : `Broadcast ${broadcastState.status}`}
            </span>
            <span>{Math.round(broadcastState.progress)}%</span>
          </div>
          <div className="progress-bar-bg">
            <div className="progress-bar-fill" style={{ width: `${broadcastState.progress}%`, background: 'linear-gradient(90deg, var(--secondary) 0%, var(--accent) 100%)' }} />
          </div>
          <div className="transfer-meta">
            <span>Room Multicast Channel</span>
            {broadcastState.status === 'transferring' && <span>Speed: {formatSpeed(broadcastState.speed)}</span>}
          </div>
          {broadcastState.error && (
            <p style={{ fontSize: '0.8rem', color: '#ff3b30', marginTop: '0.5rem', fontWeight: '500' }}>
              Error: {broadcastState.error}
            </p>
          )}
        </div>
      )}

      <div style={{ marginTop: '2.5rem' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <span>Discovered Devices</span>
            <span style={{ fontSize: '0.8rem', padding: '0.2rem 0.6rem', borderRadius: '999px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-secondary)' }}>
              {peers.length}
            </span>
          </h3>
          {peers.length > 0 && (
            <>
              <input
                ref={broadcastInputRef}
                type="file"
                style={{ display: 'none' }}
                onChange={handleBroadcastChange}
              />
              <button
                type="button"
                className="btn btn-secondary glow-effect"
                onClick={() => broadcastInputRef.current.click()}
                style={{ padding: '0.4rem 0.8rem', fontSize: '0.85rem', borderColor: 'var(--secondary)' }}
                disabled={broadcastState.status === 'transferring'}
              >
                <Radio size={16} className="text-secondary" style={{ marginRight: '0.25rem' }} /> Broadcast to Room
              </button>
            </>
          )}
        </div>

        {peers.length === 0 ? (
          <div className="empty-state">
            <Monitor className="empty-state-icon animate-bounce" size={40} />
            <p>Waiting for other devices to join this room...</p>
            <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              Open this app on another phone or computer on the same network.
            </p>
          </div>
        ) : (
          <div className="device-grid">
            {peers.map((peer) => (
              <div
                key={peer.id}
                className="device-card"
                onClick={() => onSelectPeer(peer)}
              >
                <div className="device-icon-wrapper">
                  {getDeviceIcon(peer.device)}
                </div>
                <div className="device-name" title={peer.name}>
                  {peer.name}
                </div>
                <div className="device-info">
                  {peer.device}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Private Room Channels (Separated Create and Join actions) */}
      <div className="room-actions-panel" style={{ marginTop: '3rem', paddingTop: '2rem', borderTop: '1px solid rgba(255, 255, 255, 0.05)' }}>
        <h4 style={{ fontSize: '1.0rem', fontWeight: '600', color: 'var(--text-primary)', marginBottom: '1.25rem' }}>
          Private Room Channels
        </h4>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '1.5rem' }}>
          
          {/* Create Private Room Section */}
          <div style={{ padding: '1.25rem', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--panel-border)', borderRadius: '14px', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', gap: '1rem' }}>
            <div>
              <h5 style={{ fontSize: '0.9rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Create a Private Room</h5>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', lineHeight: '1.3' }}>
                Generates a secure random room code. Share this code with friends so they can discover and connect to your device.
              </p>
            </div>
            {inPrivateRoom ? (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={handleLeavePrivateRoom}
                style={{ width: '100%', display: 'flex', gap: '0.5rem', justifyContent: 'center', alignItems: 'center' }}
              >
                <RefreshCw size={14} /> Reset to Local Network
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-primary"
                onClick={handleCreateRoom}
                style={{ width: '100%' }}
              >
                Create Room
              </button>
            )}
          </div>

          {/* Join Private Room Section */}
          <form
            onSubmit={handleJoinCodeSubmit}
            style={{ padding: '1.25rem', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid var(--panel-border)', borderRadius: '14px', display: 'flex', flexDirection: 'column', gap: '1rem' }}
          >
            <div>
              <h5 style={{ fontSize: '0.9rem', fontWeight: '600', color: 'var(--text-secondary)' }}>Join a Private Room</h5>
              <p style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '0.25rem', lineHeight: '1.3' }}>
                Enter the private room code shared by another user to immediately connect to their custom transfer session.
              </p>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                type="text"
                className="input-field"
                placeholder="Code (e.g. 582910)"
                value={manualCode}
                onChange={(e) => setManualCode(e.target.value)}
                style={{ marginBottom: 0, flex: 1, fontSize: '0.85rem' }}
              />
              <button type="submit" className="btn btn-primary" style={{ padding: '0 1rem', display: 'flex', gap: '0.25rem', alignItems: 'center' }}>
                Join <ArrowRight size={16} />
              </button>
            </div>
          </form>

        </div>
      </div>

    </div>
  );
};
