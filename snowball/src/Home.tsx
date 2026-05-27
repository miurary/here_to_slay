import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
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

          <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <h2>Ready to play?</h2>
            {nameSaved && name ? (
              <div style={{ fontSize: '1rem', color: '#222' }}>
                Welcome {name}!
              </div>
            ) : (
              <>
                <label htmlFor="name" style={{ display: 'block', marginBottom: '0.5rem' }}>
                  Username
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Enter a username"
                  style={{ width: '100%', maxWidth: '360px', padding: '0.75rem', marginBottom: '0.75rem' }}
                />
                <button type="button" onClick={handleSaveName} className="primaryButton">
                  Save Username
                </button>
              </>
            )}
          </div>

          <div className="panel" style={{ marginBottom: '1.5rem' }}>
            <h2>Create a new room</h2>
            <p>Generate a room code and invite friends to join.</p>
            <button type="button" onClick={handleCreateRoom} className="primaryButton">
              Create Game Room
            </button>
          </div>

          <div className="panel">
            <h2>Join an existing room</h2>
            <form onSubmit={handleJoinRoom}>
              <input
                type="text"
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value)}
                placeholder="Room Code"
                style={{ width: '100%', maxWidth: '240px', padding: '0.75rem', marginBottom: '0.75rem' }}
              />
              <button type="submit" className="primaryButton">
                Join Room
              </button>
            </form>
          </div>

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
