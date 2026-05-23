// client/src/App.tsx
import { useEffect, useState } from 'react';
import { io, Socket } from 'socket.io-client';

// These should match your server exactly!
interface ServerToClientEvents {
  pongClient: (data: { message: string }) => void;
}

interface ClientToServerEvents {
  pingServer: () => void;
}

// Apply the types to the client Socket instance
// Note: The order of generics is reversed on the client!
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io('http://localhost:3001');

export default function App() {
  // Explicitly tell React this state will hold a string
  const [status, setStatus] = useState<string>('Connecting...');

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

    return () => {
      socket.off('connect');
      socket.off('pongClient');
    };
  }, []);

  return (
    <div style={{ padding: '2rem', fontFamily: 'sans-serif' }}>
      <h1>Multiplayer Engine</h1>
      <p>Status: <strong>{status}</strong></p>
    </div>
  );
}