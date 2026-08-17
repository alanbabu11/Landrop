import React, { useState } from 'react';
import { Radio, ArrowRight } from 'lucide-react';

export const Onboarding = ({ onSaveName }) => {
  const [name, setName] = useState('');

  const handleSubmit = (e) => {
    e.preventDefault();
    if (name.trim()) {
      localStorage.setItem('landrop_username', name.trim());
      onSaveName(name.trim());
    }
  };

  const handleUseRandom = () => {
    const adjectives = ['Cosmic', 'Nebula', 'Quantum', 'Glitch', 'Cyber', 'Solar', 'Hydra', 'Vortex', 'Neon', 'Lunar'];
    const nouns = ['Pioneer', 'Wanderer', 'Stalker', 'Ranger', 'Specter', 'Drifter', 'Falcon', 'Titan', 'Echo', 'Phoenix'];
    const randomName = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
    localStorage.setItem('landrop_username', randomName);
    onSaveName(randomName);
  };

  return (
    <div className="glass-container glow-effect" style={{ maxWidth: '440px', textAlign: 'center', padding: '3rem 2rem' }}>
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.75rem', marginBottom: '2rem' }}>
        <Radio className="text-secondary animate-pulse" size={32} />
        <span className="logo-text" style={{ fontSize: '2.2rem' }}>LANDrop</span>
      </div>

      <h3 style={{ fontSize: '1.25rem', fontWeight: '700', marginBottom: '0.5rem', color: 'var(--text-primary)' }}>
        Welcome to LANDrop
      </h3>
      <p style={{ fontSize: '0.85rem', color: 'var(--text-secondary)', marginBottom: '2rem', lineHeight: '1.4' }}>
        Enter a display name to start discovering and sharing files with devices on your network.
      </p>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
        <input
          type="text"
          className="input-field"
          placeholder="Enter display name (e.g. Alex)"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={20}
          required
          autoFocus
          style={{ textAlign: 'center', fontSize: '1.05rem', letterSpacing: '0.5px' }}
        />
        
        <button type="submit" className="btn btn-primary" style={{ padding: '0.9rem', fontSize: '1rem', width: '100%' }}>
          Get Started <ArrowRight size={18} />
        </button>
      </form>

      <button
        type="button"
        className="btn btn-secondary"
        onClick={handleUseRandom}
        style={{ marginTop: '1.25rem', padding: '0.6rem', fontSize: '0.8rem', width: '100%', borderColor: 'rgba(255,255,255,0.05)', color: 'var(--text-muted)' }}
      >
        Or use a random codename
      </button>
    </div>
  );
};
