// client/src/App.tsx
import { useEffect, useState } from 'react';
import type { SubmitEvent } from 'react';
import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, GameState, PlayerState } from '../../shared/types'

// Apply the types to the client Socket instance
// Note: The order of generics is reversed on the client!
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io('http://localhost:3001');

export default function App() {
  const [name, setName] = useState<string>('');
  const [myId, setMyId] = useState<string>('');
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  const [myRoll, setMyRoll] = useState<number | null>(null);

  // Explicitly tell React this state will hold a string
  const [status, setStatus] = useState<string>('Connecting...');
  const [players, setPlayers] = useState<PlayerState[]>([]);

  useEffect(() => {
    socket.on('connect', () => {
      setMyId(socket.id);
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

    socket.on('stateUpdate', (state) => {
      setGameState(state);
      setStatus(`Game status: ${state.status}`);
      
      // Reset roll display when rolling phase starts
      if (state.status === 'rolling') {
        setMyRoll(null);
        setIsRolling(false);
      }
    });

    return () => {
      socket.off('connect');
      socket.off('pongClient');
      socket.off('playersUpdated');
      socket.off('stateUpdate');
    };
  }, []);

  const handleStart = () => {
    socket.emit('startGame');
  };

  const handleRoll = () => {
    setIsRolling(true);
    // Animate for 1 second then send the roll
    setTimeout(() => {
      socket.emit('rollForFirst');
      // Simulate rolling animation complete
      setTimeout(() => {
        const roll = gameState?.diceRolls[myId];
        if (roll) {
          setMyRoll(roll);
        }
        setIsRolling(false);
      }, 300);
    }, 1000);
  };

  const handleQuit = () => {
    socket.emit('quitGame');
  };

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

      {gameState?.status === 'waiting' && gameState?.lobbyLeaderId === myId && (
        <button
          type="button"
          onClick={handleStart}
          style={{ marginBottom: '1.5rem', padding: '0.5rem 1rem', fontSize: '1rem' }}
        >
          Start Game
        </button>
      )}

      {gameState?.status === 'waiting' && gameState?.lobbyLeaderId !== myId && (
        <p style={{ marginBottom: '1.5rem', color: '#666' }}>
          Waiting for {gameState.players[gameState.lobbyLeaderId]?.username || 'the lobby leader'} to start the game...
        </p>
      )}

      {gameState?.status === 'rolling' && (
        <div style={{ marginBottom: '2rem', padding: '1.5rem', border: '2px solid #007bff', borderRadius: '8px', backgroundColor: '#e7f3ff' }}>
          <h2>Roll for First Player!</h2>
          <p>Roll two 6-sided dice - highest sum goes first!</p>
          
          {gameState.currentRollerId && (
            <div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'white', borderRadius: '4px', border: '2px solid #ff9800' }}>
              <strong style={{ color: '#ff9800', fontSize: '1.1rem' }}>
                Currently rolling: {gameState.players[gameState.currentRollerId]?.username || gameState.currentRollerId}
              </strong>
            </div>
          )}

          {gameState.currentRollerId === myId && (
            <button
              type="button"
              onClick={handleRoll}
              disabled={isRolling || myRoll !== null}
              style={{
                padding: '0.75rem 1.5rem',
                fontSize: '1.1rem',
                backgroundColor: isRolling || myRoll !== null ? '#ccc' : '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: isRolling || myRoll !== null ? 'not-allowed' : 'pointer',
                marginBottom: '1rem'
              }}
            >
              {myRoll !== null ? `You rolled: ${myRoll}` : isRolling ? 'Rolling...' : 'Roll Dice'}
            </button>
          )}

          {gameState.currentRollerId !== myId && (
            <p style={{ marginBottom: '1rem', color: '#666' }}>
              Waiting for {gameState.players[gameState.currentRollerId]?.username || 'a player'} to roll...
            </p>
          )}

          {isRolling && (
            <div style={{ fontSize: '2rem', marginBottom: '1rem', animation: 'spin 0.1s infinite' }}>
              🎲 🎲
            </div>
          )}

          <div style={{ marginTop: '1.5rem' }}>
            <h4>Roll Results:</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.5rem' }}>
              {gameState?.diceRolls && Object.entries(gameState.diceRolls).length > 0 ? (
                Object.entries(gameState.diceRolls).map(([playerId, roll]) => {
                  const player = gameState.players[playerId];
                  return (
                    <div key={playerId} style={{ padding: '0.75rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                      <div style={{ fontWeight: 'bold' }}>{player.username || 'Player'}</div>
                      <div style={{ fontSize: '1.5rem', color: '#007bff' }}>{roll}</div>
                    </div>
                  );
                })
              ) : (
                <p style={{ color: '#999' }}>No rolls yet...</p>
              )}
            </div>
          </div>

          <style>{`
            @keyframes spin {
              0% { transform: rotateX(0deg) rotateY(0deg); }
              100% { transform: rotateX(360deg) rotateY(360deg); }
            }
          `}</style>
        </div>
      )}

      {gameState?.status === 'in_progress' && (
        <button
          type="button"
          onClick={handleQuit}
          style={{ marginBottom: '1.5rem', padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#ff6b6b', color: 'white' }}
        >
          Quit Game
        </button>
      )}
      {gameState && (
        <p>Current game status: <strong>{gameState.status}</strong></p>
      )}

      {gameState && gameState.status === 'in_progress' && gameState.players[myId] && (
        <div style={{ marginBottom: '2rem', padding: '1rem', border: '1px solid #ccc', borderRadius: '4px' }}>
          <h3>Your Hand ({gameState.players[myId].zones.hand.length} cards)</h3>
          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
            {gameState.players[myId].zones.hand.map((card) => {
              const template = gameState.cardTemplates[card.templateId];
              const cardName = template?.name || card.templateId;
              const abilityText = (template?.abilityText as string) || '';
              return (
                <div
                  key={card.instanceId}
                  style={{
                    border: '1px solid #333',
                    borderRadius: '4px',
                    padding: '0.75rem',
                    minWidth: '120px',
                    maxWidth: '150px',
                    backgroundColor: '#f0f0f0',
                    textAlign: 'center',
                  }}
                >
                  <div style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>{cardName}</div>
                  <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '0.25rem' }}>
                    {card.cardType}
                  </div>
                  {abilityText && (
                    <div style={{ fontSize: '0.65rem', color: '#333', marginTop: '0.5rem', fontStyle: 'italic', lineHeight: '1.3' }}>
                      {abilityText}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

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