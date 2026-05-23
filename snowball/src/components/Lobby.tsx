// client/src/App.tsx
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents} from '../../shared/types'

// Apply the types to the client Socket instance
// Note: The order of generics is reversed on the client!
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io('http://localhost:3001');

export default function App() {
  const [name, setName] = useState<string>('');

  // Explicitly tell React this state will hold a string
  const [status, setStatus] = useState<string>('Connecting...');
  const [players, setPlayers] = useState<string[]>([]);

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
    };
  }, []);

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Multiplayer Engine</h1>
      <p>Status: <strong>{status}</strong></p>
      <h3>Players Connected</h3>
      {players.map((value, index) => (
        <p key={index}>{value}</p>
      ))}
    </div>
  );
}