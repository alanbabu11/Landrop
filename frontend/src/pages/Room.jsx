import React, { useRef, useState } from 'react';
import { ArrowLeft, UploadCloud, File, AlertCircle, CheckCircle2, RefreshCw } from 'lucide-react';
import { formatSize, formatSpeed } from '../utils/fileTransfer';

export const Room = ({
  peer,
  connectionState,
  transferState,
  onDisconnect,
  onSendFile,
}) => {
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef(null);

  const handleDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') {
      setIsDragActive(true);
    } else if (e.type === 'dragleave') {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);

    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (onSendFile) onSendFile(file);
    }
  };

  const handleFileChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (onSendFile) onSendFile(file);
    }
  };

  const onButtonClick = () => {
    fileInputRef.current.click();
  };

  const getStatusMessage = () => {
    if (transferState.mode === 'relay') {
      if (transferState.status === 'connecting') {
        return {
          text: 'Establishing fallback WebSocket relay connection...',
          icon: <RefreshCw className="text-secondary animate-spin" size={20} />,
        };
      }
      return {
        text: 'Fallback Relay Active (WebSocket Mode). Sharing files via server.',
        icon: <CheckCircle2 className="text-secondary" style={{ color: '#00ffff' }} size={20} />,
      };
    }

    switch (connectionState) {
      case 'new':
      case 'connecting':
        return {
          text: 'Establishing secure peer-to-peer connection...',
          icon: <RefreshCw className="text-secondary animate-spin" size={20} />,
        };
      case 'connected':
        return {
          text: 'Direct P2P Link Established. Drag files here or click to send.',
          icon: <CheckCircle2 style={{ color: '#00ff66' }} size={20} />,
        };
      case 'failed':
      case 'disconnected':
      case 'closed':
        return {
          text: 'Direct connection timed out. Handshaking server fallback...',
          icon: <AlertCircle className="text-secondary animate-pulse" size={20} />,
        };
      default:
        return { text: '', icon: null };
    }
  };

  const status = getStatusMessage();
  const isTransferringOrVerifying = ['transferring', 'hashing', 'verifying'].includes(transferState.status);

  return (
    <div className="glass-container glow-effect">
      <div className="header" style={{ marginBottom: '1.5rem' }}>
        <button className="btn btn-secondary" onClick={onDisconnect} style={{ padding: '0.5rem 1rem' }} disabled={isTransferringOrVerifying}>
          <ArrowLeft size={18} /> Back
        </button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
          Target Device: <strong style={{ color: 'var(--text-primary)' }}>{peer.name}</strong>
        </span>
      </div>

      <div style={{ padding: '1rem', background: 'rgba(0, 0, 0, 0.15)', borderRadius: '16px', border: '1px solid var(--panel-border)', marginBottom: '1.5rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          {status.icon}
          <span style={{ fontSize: '0.9rem', color: 'var(--text-primary)' }}>
            {status.text}
          </span>
        </div>
      </div>

      <div
        className={`dropzone ${isDragActive ? 'drag-active' : ''} ${isTransferringOrVerifying ? 'disabled' : ''}`}
        onDragEnter={isTransferringOrVerifying ? undefined : handleDrag}
        onDragOver={isTransferringOrVerifying ? undefined : handleDrag}
        onDragLeave={isTransferringOrVerifying ? undefined : handleDrag}
        onDrop={isTransferringOrVerifying ? undefined : handleDrop}
        onClick={isTransferringOrVerifying ? undefined : onButtonClick}
        style={{ pointerEvents: isTransferringOrVerifying ? 'none' : 'auto', opacity: isTransferringOrVerifying ? 0.4 : 1 }}
      >
        <input
          ref={fileInputRef}
          type="file"
          className="file-input"
          onChange={handleFileChange}
        />
        <UploadCloud className="dropzone-icon" size={54} />
        <div>
          <h3 style={{ fontSize: '1.1rem', fontWeight: '600', marginBottom: '0.25rem' }}>
            Drag & Drop your file here
          </h3>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)' }}>
            or click to browse local files
          </p>
        </div>
      </div>

      {transferState.active && (
        <div className="transfer-panel" style={{ border: transferState.status === 'completed' ? '1px solid #00ff66' : transferState.status === 'failed' ? '1px solid #ff3b30' : '1px solid var(--panel-border)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1rem' }}>
            <File className="text-secondary" size={24} />
            <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
              <p style={{ fontWeight: '600', fontSize: '0.95rem' }}>{transferState.name}</p>
              <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>{formatSize(transferState.size)}</p>
            </div>
            {transferState.status === 'completed' && (
              <CheckCircle2 style={{ color: '#00ff66' }} size={24} />
            )}
            {transferState.status === 'failed' && (
              <AlertCircle style={{ color: '#ff3b30' }} size={24} />
            )}
          </div>
          
          <div className="transfer-header">
            <span style={{ textTransform: 'capitalize' }}>
              {transferState.status === 'hashing' && 'Calculating SHA-256 signature...'}
              {transferState.status === 'verifying' && 'Verifying secure file signature...'}
              {transferState.status === 'transferring' && `${transferState.direction === 'send' ? 'Sending' : 'Receiving'} file...`}
              {transferState.status === 'completed' && 'Secure Transfer Verified & Saved'}
              {transferState.status === 'failed' && 'Transfer failed'}
            </span>
            <span>{Math.round(transferState.progress)}%</span>
          </div>
          <div className="progress-bar-bg">
            <div className="progress-bar-fill" style={{ width: `${transferState.progress}%`, background: transferState.status === 'completed' ? '#00ff66' : transferState.status === 'failed' ? '#ff3b30' : 'linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%)' }} />
          </div>
          <div className="transfer-meta">
            <span>
              {transferState.mode === 'p2p' ? 'Direct P2P Link' : 'Server Relay Connection'}
            </span>
            {transferState.status === 'transferring' && (
              <span>Speed: {formatSpeed(transferState.speed)}</span>
            )}
          </div>
          {transferState.error && (
            <p style={{ color: '#ff3b30', fontSize: '0.85rem', marginTop: '0.5rem', fontWeight: '500' }}>
              {transferState.error}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
