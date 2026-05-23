// client/src/App.tsx
import { useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, Player } from '../../shared/types'

// Apply the types to the client Socket instance
// Note: The order of generics is reversed on the client!
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io('http://localhost:3001');

export default function App() {
  const [name, setName] = useState<string>('');

  // Explicitly tell React this state will hold a string
  const [status, setStatus] = useState<string>('Connecting...');
  const [players, setPlayers] = useState<Player[]>([]);

  useEffect(() => {
    socket.on('connect', () => {
      setStatus('Connected to Game Server!');
      
      // Try typing `socket.emit('badName')` here. TS will throw an error!
      socket.emit('pingServer');
    });

    socket.on('pongClient', (data) => {
      // TS knows `data.message` exists, giving you perfect autocomplete
      console.log("Server says:", data.message);
    });

    socket.on('playersUpdated', (connectedPlayers) => {
      setPlayers(connectedPlayers);
    });

    return () => {
      socket.off('connect');
      socket.off('pongClient');
      socket.off('playersUpdated');
    };
  }, []);

  const handleSubmit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!name.trim()) {
      setStatus('Please enter a username');
      return;
    }

    socket.emit('setUsername', name.trim());
    setStatus(`Username set to ${name.trim()}`);
  };

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Here to Slay Online</h1>
      <p>Status: <strong>{status}</strong></p>

      <form onSubmit={handleSubmit} style={{ marginBottom: '1.5rem' }}>
        <label htmlFor="username" style={{ display: 'block', marginBottom: '0.5rem' }}>
          Enter your username:
        </label>
        <input
          id="username"
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Username"
          style={{ padding: '0.5rem', fontSize: '1rem', width: '100%', maxWidth: '320px', boxSizing: 'border-box' }}
        />
        <button
          type="submit"
          style={{ marginTop: '0.75rem', padding: '0.5rem 1rem', fontSize: '1rem' }}
        >
          Save Username
        </button>
      </form>

      <h3>Players Connected</h3>
      {players.length === 0 ? (
        <p>No players connected yet.</p>
      ) : (
        players.map((player) => (
          <p key={player.id}>{player.username || player.id}</p>
        ))
      )}
    </div>
  );
}