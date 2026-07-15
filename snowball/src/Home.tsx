import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import PregameShell from './components/pregame/PregameShell';
import HomePanel from './components/pregame/HomePanel';
import './App.css';

export default function Home() {
  const navigate = useNavigate();
  const location = useLocation();
  const storedName = localStorage.getItem('username') ?? '';
  const [name, setName] = useState(storedName);
  const [roomCode, setRoomCode] = useState('');
  const [status, setStatus] = useState<string>((location.state as { error?: string } | null)?.error ?? '');

  const saveName = () => {
    const trimmed = name.trim();
    if (trimmed) localStorage.setItem('username', trimmed);
  };

  const handleCreateRoom = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setStatus('Please enter a username first.');
      return;
    }
    localStorage.setItem('username', trimmedName);
    setStatus('Creating room...');

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/api/create-room`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await response.json();
      if (!response.ok || !data.roomCode) {
        setStatus('Failed to create room.');
        return;
      }
      navigate(`/game/${data.roomCode}`);
    } catch {
      setStatus('Unable to connect to the game server.');
    }
  };

  const handleJoinRoom = async () => {
    const trimmedRoom = roomCode.trim().toUpperCase();
    if (!trimmedRoom) {
      setStatus('Enter a room code to join.');
      return;
    }
    if (!name.trim()) {
      setStatus('Please enter a username before joining.');
      return;
    }
    localStorage.setItem('username', name.trim());
    setStatus('Joining room...');

    try {
      const response = await fetch(`${import.meta.env.VITE_API_URL}/api/room/${trimmedRoom}`);
      const data = await response.json();
      if (!response.ok || !data.exists) {
        setStatus(`Room ${trimmedRoom} not found.`);
        return;
      }
      navigate(`/game/${trimmedRoom}`);
    } catch {
      setStatus('Unable to connect to the game server.');
    }
  };

  return (
    <PregameShell
      showRoomChrome={false}
      statusMain="WELCOME"
      statusSub={status || 'set your name, then create or join a room'}
      statusGold={false}
    >
      <HomePanel
        name={name}
        onNameChange={setName}
        onNameSave={saveName}
        onCreateRoom={handleCreateRoom}
        joinCode={roomCode}
        onJoinChange={setRoomCode}
        onJoinRoom={handleJoinRoom}
      />
    </PregameShell>
  );
}
