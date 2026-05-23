import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';

const socket = io('http://localhost:3001');

function App() {
  const [status, setStatus] = useState('Connecting...');

  useEffect(() => {
    socket.on('connect', () => {
      setStatus('Connected to Game Server!');
      socket.emit('pingServer');
    });

    socket.on('pongClient', (data) => {
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

export default App;