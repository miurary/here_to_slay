import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import UsernameCard from './components/home/UsernameCard';
import CreateNewRoomCard from './components/home/CreateNewRoomCard';
import JoinExistingRoomCard from './components/home/JoinExistingRoomCard';
import './App.css';

export default function Home() {
  const navigate = useNavigate();
  const storedName = localStorage.getItem('username') ?? '';
  const [name, setName] = useState(storedName);
  const [nameSaved, setNameSaved] = useState(Boolean(storedName));
  const [roomCode, setRoomCode] = useState('');
  const [status, setStatus] = useState('');

  const handleSaveName = () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus('Enter a username before creating a room.');
      return;
    }

    localStorage.setItem('username', trimmed);
    setNameSaved(true);
    setStatus(`Welcome ${trimmed}! Your username is set.`);
  };

  const handleCreateRoom = async () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setStatus('Please enter a username first.');
      return;
    }

    localStorage.setItem('username', trimmedName);
    setNameSaved(true);
    setStatus('Creating room...');

    try {
      const response = await fetch('http://localhost:3001/api/create-room', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      });
      const data = await response.json();

      if (!response.ok || !data.roomCode) {
        setStatus('Failed to create room.');
        return;
      }

      navigate(`/game/${data.roomCode}`);
    } catch (error) {
      setStatus('Unable to connect to the game server.');
    }
  };

  const handleJoinRoom = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
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
    setNameSaved(true);
    navigate(`/game/${trimmedRoom}`);
  };

  return (
    <div className="appShell">
      <div className="appPage">
        <div style={{ maxWidth: '720px', margin: '0 auto' }}>
          <h1>Here to Slay Online</h1>
          <p>Start or join a room, then share the link with friends.</p>
          <UsernameCard
            nameSaved={nameSaved}
            name={name}
            setName={setName}
            handleSaveName={handleSaveName}
          />

          <CreateNewRoomCard handleCreateRoom={handleCreateRoom} />

          <JoinExistingRoomCard roomCode={roomCode} setRoomCode={setRoomCode} handleJoinRoom={handleJoinRoom}/>

          {status && (
            <div style={{ marginTop: '1rem', color: '#333' }}>
              {status}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
