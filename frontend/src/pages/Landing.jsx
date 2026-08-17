import React, { useState, useRef } from 'react';
import { Monitor, Smartphone, Laptop, Radio, ArrowRight, CheckCircle2, AlertCircle } from 'lucide-react';
import { formatSize, formatSpeed } from '../utils/fileTransfer';

const getDeviceIcon = (deviceStr) => {
  const ds = deviceStr.toLowerCase();
  if (ds.includes('phone') || ds.includes('ios') || ds.includes('android')) return <Smartphone size={24} />;
  if (ds.includes('mac') || ds.includes('windows') || ds.includes('linux')) return <Laptop size={24} />;
  return <Monitor size={24} />;
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
          <span className="room-display-label">Current Room IP / Code:</span>
          <div className="room-display-code">{roomId || 'Fetching...'}</div>
        </div>
        <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', maxWidth: '50%' }}>
          Devices on the same network or with the same room code will discover each other automatically.
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

      <form className="room-join-panel" onSubmit={handleJoinCodeSubmit}>
        <h4 style={{ fontSize: '0.95rem', fontWeight: '600', color: 'var(--text-secondary)' }}>
          Join via manual room code
        </h4>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <input
            type="text"
            className="input-field"
            placeholder="Enter custom room code (e.g. 5678)"
            value={manualCode}
            onChange={(e) => setManualCode(e.target.value)}
            style={{ marginBottom: 0 }}
          />
          <button type="submit" className="btn btn-primary" style={{ padding: '0 1.5rem' }}>
            Join <ArrowRight size={18} />
          </button>
        </div>
      </form>
    </div>
  );
};
