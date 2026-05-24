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
  const [showDrawPrompt, setShowDrawPrompt] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [justDrew, setJustDrew] = useState(false);
  const [selectedHeroId, setSelectedHeroId] = useState<string | null>(null);

  // Explicitly tell React this state will hold a string
  const [status, setStatus] = useState<string>('Connecting...');
  const [players, setPlayers] = useState<PlayerState[]>([]);

  useEffect(() => {
    socket.on('connect', () => {
      if (socket.id) {
        setMyId(socket.id);
      }
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

      if (state.status === 'rolling') {
        const currentId = socket.id;
        setMyRoll(currentId ? state.diceRolls[currentId] ?? null : null);
        setIsRolling(false);
      } else {
        setMyRoll(null);
        setIsRolling(false);
      }
    });

    socket.on('actionFailed', (msg) => {
      setActionMessage(msg);
      setTimeout(() => setActionMessage(null), 2500);
    });

    socket.on('cardDrawn', () => {
      setJustDrew(true);
      setTimeout(() => setJustDrew(false), 800);
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
    setTimeout(() => {
      socket.emit('rollForFirst');
    }, 1000);
  };

  const handleContinue = () => {
    socket.emit('continueGame');
  };

  const handleChoosePartyLeader = (instanceId: string) => {
    if (gameState?.status !== 'party_leader_selection') {
      return;
    }
    socket.emit('choosePartyLeader', instanceId);
  };

  const handleQuit = () => {
    socket.emit('quitGame');
  };

  const handleEndTurn = () => {
    socket.emit('endTurn');
  };

  const handlePlayHero = (instanceId: string) => {
    if (!gameState || gameState.status !== 'in_progress') {
      return;
    }

    socket.emit('playHero', instanceId);
    setSelectedHeroId(null);
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

  const selectedHero = gameState?.players[myId]?.zones.hand.find((card) => card.instanceId === selectedHeroId);
  const selectedHeroAP = selectedHero ? gameState?.players[myId]?.actionPoints ?? 0 : 0;

  return (
    <div
      style={{ minHeight: '100vh', padding: '1.5rem', fontFamily: 'sans-serif', backgroundColor: '#eef2f6' }}
      onClick={() => setSelectedHeroId(null)}
    >
      <div style={{ maxWidth: '1800px', margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
        <div>
          <h1>Here to Slay Online</h1>
          <p>Status: <strong>{status}</strong></p>
        </div>

        <div>
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
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', minHeight: 'calc(100vh - 260px)' }}>
          <main style={{ flex: 1, minWidth: 0 }}>
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
          Waiting for {gameState.lobbyLeaderId ? gameState.players[gameState.lobbyLeaderId]?.username : 'the lobby leader'} to start the game...
        </p>
      )}

      {gameState?.status === 'rolling' && (
        <div style={{ marginBottom: '2rem', padding: '1.5rem', border: '2px solid #007bff', borderRadius: '8px', backgroundColor: '#e7f3ff' }}>
          <h2>Roll for First Player!</h2>
          <p>Roll two 6-sided dice - highest sum goes first!</p>
          
          {gameState.currentRollerId && (
            <div style={{ marginBottom: '1.5rem', padding: '1rem', backgroundColor: 'white', borderRadius: '4px', border: '2px solid #ff9800' }}>
              <strong style={{ color: '#ff9800', fontSize: '1.1rem' }}>
                Currently rolling: {gameState.currentRollerId ? gameState.players[gameState.currentRollerId]?.username || gameState.currentRollerId : 'Unknown'}
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
              Waiting for {gameState.currentRollerId ? gameState.players[gameState.currentRollerId]?.username : 'a player'} to roll...
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

      {gameState?.status === 'roll_complete' && (
        <div style={{ marginBottom: '2rem', padding: '1.5rem', border: '2px solid #28a745', borderRadius: '8px', backgroundColor: '#e9f7ef' }}>
          <h2>Roll Results</h2>
          <p style={{ fontSize: '1rem', marginBottom: '1rem' }}>
            {gameState.rollWinnerId
              ? `${gameState.players[gameState.rollWinnerId]?.username || 'A player'} won and will go first!`
              : 'All players have rolled. See results below.'}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            {Object.entries(gameState.diceRolls).map(([playerId, roll]) => {
              const player = gameState.players[playerId];
              return (
                <div key={playerId} style={{ padding: '0.75rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                  <div style={{ fontWeight: 'bold' }}>{player.username || 'Player'}</div>
                  <div style={{ fontSize: '1.5rem', color: '#28a745' }}>{roll}</div>
                </div>
              );
            })}
          </div>

          {gameState.lobbyLeaderId === myId ? (
            <button
              type="button"
              onClick={handleContinue}
              style={{ padding: '0.75rem 1.5rem', fontSize: '1.1rem', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Continue to Game
            </button>
          ) : (
            <p style={{ color: '#666' }}>
              Waiting for {gameState.lobbyLeaderId ? gameState.players[gameState.lobbyLeaderId]?.username : 'the lobby leader'} to continue to the game...
            </p>
          )}
        </div>
      )}

      {gameState?.status === 'party_leader_selection' && (
        <div style={{ marginBottom: '2rem', padding: '1.5rem', border: '2px solid #6f42c1', borderRadius: '8px', backgroundColor: '#f3eefc' }}>
          <h2>Select Your Party Leader</h2>
          <p style={{ marginBottom: '1rem' }}>
            Current chooser: {gameState.currentSelectionPlayerId ? gameState.players[gameState.currentSelectionPlayerId]?.username || 'Player' : 'None'}
          </p>
          <p style={{ marginBottom: '1rem', color: '#333' }}>
            {gameState.currentSelectionPlayerId === myId
              ? 'It is your turn to choose a party leader from the face down cards below.'
              : 'Waiting for the current player to choose a party leader.'}
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            {gameState.availablePartyLeaderCards.map((card) => (
              <button
                key={card.instanceId}
                type="button"
                onClick={() => handleChoosePartyLeader(card.instanceId)}
                disabled={gameState.currentSelectionPlayerId !== myId}
                style={{
                  height: '150px',
                  backgroundColor: '#4a148c',
                  color: 'white',
                  borderRadius: '8px',
                  border: '2px solid #2e0a4d',
                  cursor: gameState.currentSelectionPlayerId === myId ? 'pointer' : 'not-allowed',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                }}
              >
                <div style={{ fontSize: '1rem', fontWeight: 'bold' }}>Party Leader</div>
                <div style={{ marginTop: '0.5rem', opacity: 0.85 }}>
                  Face Down
                </div>
              </button>
            ))}
          </div>

          <div>
            <h4>Chosen Party Leaders</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '0.75rem' }}>
              {Object.values(gameState.players).map((player) => {
                const chosen = player.zones.party[0];
                const template = chosen ? gameState.cardTemplates[chosen.templateId] : undefined;
                return (
                  <div key={player.id} style={{ padding: '0.75rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{player.username || 'Player'}</div>
                    {chosen ? (
                      <>
                        <div style={{ fontSize: '0.9rem' }}>{template?.name || chosen.templateId}</div>
                        <div style={{ fontSize: '0.75rem', color: '#666' }}>{(template?.abilityText as string) || ''}</div>
                      </>
                    ) : (
                      <div style={{ color: '#999' }}>Not chosen yet</div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {gameState?.status === 'party_leader_review' && (
        <div style={{ marginBottom: '2rem', padding: '1.5rem', border: '2px solid #20c997', borderRadius: '8px', backgroundColor: '#e6fffa' }}>
          <h2>Party Leader Review</h2>
          <p style={{ fontSize: '1rem', marginBottom: '1rem' }}>
            All players have chosen their party leaders. Review the choices below before continuing into the game.
          </p>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: '0.75rem', marginBottom: '1rem' }}>
            {Object.values(gameState.players).map((player) => {
              const chosen = player.zones.party[0];
              const template = chosen ? gameState.cardTemplates[chosen.templateId] : undefined;
              return (
                <div key={player.id} style={{ padding: '1rem', backgroundColor: 'white', borderRadius: '4px', border: '1px solid #ddd' }}>
                  <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{player.username || 'Player'}</div>
                  {chosen ? (
                    <>
                      <div style={{ fontSize: '1rem', marginBottom: '0.25rem' }}>{template?.name || chosen.templateId}</div>
                      <div style={{ fontSize: '0.8rem', color: '#666' }}>{chosen.cardType}</div>
                      <div style={{ marginTop: '0.5rem', fontSize: '0.75rem', color: '#333' }}>{(template?.abilityText as string) || 'No ability text available.'}</div>
                    </>
                  ) : (
                    <div style={{ color: '#999' }}>No party leader chosen</div>
                  )}
                </div>
              );
            })}
          </div>

          <div style={{ marginBottom: '1.5rem' }}>
            <h3>Revealed Monsters</h3>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '0.75rem' }}>
              {gameState.activeMonsters.map((monster) => {
                const template = gameState.cardTemplates[monster.templateId];
                const requirements = (template?.requirements as Array<{ class?: string; amount?: number }> | undefined) ?? [];
                const requirementText = requirements.length > 0
                  ? requirements.map((req) => `${req.amount ?? '?'} ${req.class ?? 'Any'}`).join(', ')
                  : 'No requirements';
                const lowerBound = template?.lowerBound as number | undefined;
                const lowerBoundText = template?.lowerBoundText as string | undefined;
                const upperBound = template?.upperBound as number | undefined;
                const upperBoundText = template?.upperBoundText as string | undefined;
                const slainEffectText = template?.slainEffectText as string | undefined;

                return (
                  <div key={monster.instanceId} style={{ padding: '1rem', backgroundColor: 'white', borderRadius: '8px', border: '1px solid #ddd' }}>
                    <div style={{ fontWeight: 'bold', marginBottom: '0.5rem' }}>{template?.name || monster.templateId}</div>
                    <div style={{ fontSize: '0.75rem', color: '#666', marginBottom: '0.75rem' }}>{requirementText}</div>

                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                      <span style={{ fontWeight: 'bold' }}>{lowerBound !== undefined ? `${lowerBound}-` : 'Lower:'}</span>
                      <span style={{ fontSize: '0.85rem', color: '#333' }}>{lowerBoundText ?? 'No lower bound text'}</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.75rem' }}>
                      <span style={{ fontWeight: 'bold' }}>{upperBound !== undefined ? `${upperBound}+` : 'Upper:'}</span>
                      <span style={{ fontSize: '0.85rem', color: '#333' }}>{upperBoundText ?? 'No upper bound text'}</span>
                    </div>

                    {slainEffectText && (
                      <div style={{ marginTop: '0.5rem', padding: '0.75rem', borderRadius: '6px', backgroundColor: '#f8f0ff', color: '#333' }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Slain Effect</div>
                        <div style={{ fontSize: '0.8rem' }}>{slainEffectText}</div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {gameState.lobbyLeaderId === myId ? (
            <button
              type="button"
              onClick={handleContinue}
              style={{ padding: '0.75rem 1.5rem', fontSize: '1.1rem', backgroundColor: '#20c997', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
            >
              Continue to Game
            </button>
          ) : (
            <p style={{ color: '#666' }}>
              Waiting for {gameState.lobbyLeaderId ? gameState.players[gameState.lobbyLeaderId]?.username : 'the lobby leader'} to continue to the game...
            </p>
          )}
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

      {gameState?.status === 'in_progress' && (
        <div style={{ marginBottom: '1rem', padding: '1rem', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#f8f9fa' }}>
          <p style={{ margin: '0 0 0.5rem 0' }}>
            Current turn: <strong>{gameState.activePlayerId ? gameState.players[gameState.activePlayerId]?.username || gameState.activePlayerId : 'None'}</strong>
            {gameState.activePlayerId === myId ? ' (your turn)' : ''}
          </p>
          <p style={{ margin: '0 0 0.5rem 0' }}>
            Turn #: <strong>{gameState.turnNumber ?? 0}</strong>
          </p>
          <p style={{ margin: 0 }}>
            Your AP: <strong>{gameState.players[myId]?.actionPoints ?? 0}</strong>
          </p>
        </div>
      )}

      {gameState && gameState.status === 'in_progress' && gameState.players[myId] && (
        <>
          <div style={{ marginBottom: '2rem', display: 'flex', gap: '1rem', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {gameState.players[myId].zones.party[0] && (() => {
              const partyLeader = gameState.players[myId].zones.party[0];
              const template = gameState.cardTemplates[partyLeader.templateId];
              const cardName = template?.name || partyLeader.templateId;
              const abilityText = (template?.abilityText as string) || '';
              return (
                <div style={{ width: '220px', padding: '1rem', border: '2px solid #333', borderRadius: '8px', backgroundColor: '#faf7f0' }}>
                  <h3 style={{ marginTop: 0 }}>Your Party Leader</h3>
                  <div style={{ fontSize: '1rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>{cardName}</div>
                  <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.75rem' }}>{partyLeader.cardType}</div>
                  {abilityText && (
                    <div style={{ fontSize: '0.8rem', color: '#333', lineHeight: '1.4' }}>{abilityText}</div>
                  )}
                </div>
              );
            })()}

            <div style={{ width: '260px', padding: '1rem', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#fff' }}>
              <h3 style={{ marginTop: 0 }}>Your Party</h3>
              <div style={{ minHeight: '120px', display: 'grid', gap: '0.75rem' }}>
                {gameState.players[myId].zones.party.filter((card) => card.cardType === 'hero').length > 0 ? (
                  gameState.players[myId].zones.party
                    .filter((card) => card.cardType === 'hero')
                    .map((card) => {
                      const template = gameState.cardTemplates[card.templateId];
                      return (
                        <div key={card.instanceId} style={{ padding: '0.75rem', border: '1px solid #333', borderRadius: '6px', backgroundColor: '#f7f7ff' }}>
                          <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{template?.name || card.templateId}</div>
                          <div style={{ fontSize: '0.8rem', color: '#666' }}>{template?.class || 'Hero'}</div>
                        </div>
                      );
                    })
                ) : (
                  <div style={{ color: '#666' }}>Play hero cards from your hand to your party.</div>
                )}
              </div>
            </div>

            <div style={{ flex: 1, minWidth: '320px', padding: '1rem', border: '1px solid #ccc', borderRadius: '4px', backgroundColor: '#fff' }}>
              <h3>Your Hand ({gameState.players[myId].zones.hand.length} cards)</h3>
              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {gameState.players[myId].zones.hand.map((card) => {
                  const template = gameState.cardTemplates[card.templateId];
                  const cardName = template?.name || card.templateId;
                  const abilityText = (template?.abilityText as string) || '';
                  const rollToPlay = template?.rollToPlay as number | undefined;
                  const heroClass = template?.class as string | undefined;
                  return (
                    <div
                      key={card.instanceId}
                      onClick={(event) => {
                        event.stopPropagation();
                        if (card.cardType === 'hero') {
                          setSelectedHeroId(card.instanceId);
                        }
                      }}
                      style={{
                        border: selectedHeroId === card.instanceId ? '2px solid #007bff' : '1px solid #333',
                        borderRadius: '4px',
                        padding: '0.75rem',
                        minWidth: '120px',
                        maxWidth: '150px',
                        backgroundColor: selectedHeroId === card.instanceId ? '#e7f3ff' : '#f0f0f0',
                        textAlign: 'center',
                        cursor: card.cardType === 'hero' ? 'pointer' : 'default',
                      }}
                    >
                      <div style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>{cardName}</div>
                      <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '0.25rem' }}>
                        {card.cardType}
                      </div>
                      {card.cardType === 'hero' && (
                        <>
                          {heroClass && (
                            <div style={{ fontSize: '0.75rem', color: '#444', marginTop: '0.5rem' }}>
                              Class: {heroClass}
                            </div>
                          )}
                          {rollToPlay !== undefined && (
                            <div style={{ fontSize: '0.75rem', color: '#444', marginTop: '0.25rem' }}>
                              Roll to play: +{rollToPlay}
                            </div>
                          )}
                        </>
                      )}
                      {abilityText && (
                        <div style={{ fontSize: '0.65rem', color: '#333', marginTop: '0.5rem', fontStyle: 'italic', lineHeight: '1.3' }}>
                          {abilityText}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {selectedHero && (
                <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #007bff', borderRadius: '8px', backgroundColor: '#e7f3ff' }}>
                  <div style={{ marginBottom: '0.75rem' }}>
                    <strong>Selected Hero:</strong> {selectedHero ? gameState.cardTemplates[selectedHero.templateId]?.name || 'Hero' : 'None'}
                  </div>
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handlePlayHero(selectedHero.instanceId);
                    }}
                    disabled={selectedHeroAP < 1}
                    style={{
                      padding: '0.75rem 1.25rem',
                      fontSize: '1rem',
                      backgroundColor: selectedHeroAP < 1 ? '#ccc' : '#007bff',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: selectedHeroAP < 1 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    Play Hero (-1 AP)
                  </button>
                  {selectedHeroAP < 1 && (
                    <div style={{ marginTop: '0.75rem', color: '#c00' }}>
                      You need at least 1 AP to play this hero.
                    </div>
                  )}
                </div>
              )}
            </div>

            <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: '#fdf9f1' }}>
              <h3>Active Monsters</h3>
              <div style={{ display: 'grid', gap: '0.75rem' }}>
                {gameState.activeMonsters.map((monster) => {
                  const template = gameState.cardTemplates[monster.templateId];
                  const requirements = (template?.requirements as Array<{ class?: string; amount?: number }> | undefined) ?? [];
                  const requirementText = requirements.length > 0
                    ? requirements.map((req) => `${req.amount ?? '?'} ${req.class ?? 'Any'}`).join(', ')
                    : 'No requirements';
                  const lowerBound = template?.lowerBound as number | undefined;
                  const lowerBoundText = template?.lowerBoundText as string | undefined;
                  const upperBound = template?.upperBound as number | undefined;
                  const upperBoundText = template?.upperBoundText as string | undefined;
                  const slainEffectText = template?.slainEffectText as string | undefined;

                  return (
                    <div key={monster.instanceId} style={{ padding: '0.75rem', border: '1px solid #aaa', borderRadius: '8px', backgroundColor: 'white' }}>
                      <div style={{ fontWeight: 'bold', marginBottom: '0.35rem' }}>{template?.name || monster.templateId}</div>
                      <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.75rem' }}>{requirementText}</div>

                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                        <span style={{ fontWeight: 'bold' }}>{lowerBound !== undefined ? `${lowerBound}-` : 'Lower:'}</span>
                        <span style={{ fontSize: '0.85rem', color: '#333' }}>{lowerBoundText ?? 'No lower bound text'}</span>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.75rem' }}>
                        <span style={{ fontWeight: 'bold' }}>{upperBound !== undefined ? `${upperBound}+` : 'Upper:'}</span>
                        <span style={{ fontSize: '0.85rem', color: '#333' }}>{upperBoundText ?? 'No upper bound text'}</span>
                      </div>

                      {slainEffectText && (
                        <div style={{ fontSize: '0.8rem', color: '#333', backgroundColor: '#fff8e1', padding: '0.75rem', borderRadius: '6px' }}>
                          <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Slain Effect</div>
                          {slainEffectText}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          <div style={{ marginBottom: '1rem' }}>
            {gameState.activePlayerId === myId && (
              <button
                type="button"
                onClick={handleEndTurn}
                style={{ padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '4px' }}
              >
                End Turn
              </button>
            )}
          </div>
          <div style={{ marginBottom: '1rem' }}>
            <h3>Main Deck</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div
                onClick={() => {
                  if (gameState.status !== 'in_progress' || gameState.activePlayerId !== myId) {
                    setActionMessage('Not your turn to draw');
                    setTimeout(() => setActionMessage(null), 1800);
                    return;
                  }
                  setShowDrawPrompt(true);
                }}
                style={{ width: '120px', height: '160px', backgroundColor: '#2e2e2e', color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '6px', cursor: gameState.activePlayerId === myId ? 'pointer' : 'not-allowed' }}
              >
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 'bold' }}>Deck</div>
                  <div style={{ fontSize: '0.9rem' }}>{gameState.mainDeck.length} cards</div>
                </div>
              </div>

              {showDrawPrompt && (
                <>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                    <button
                      onClick={() => {
                        const myAP = gameState.players[myId]?.actionPoints ?? 0;
                        if (myAP >= 1) {
                          socket.emit('drawFromMain');
                        }
                        setShowDrawPrompt(false);
                      }}
                      disabled={(gameState.players[myId]?.actionPoints ?? 0) < 1}
                      style={{ padding: '0.5rem 1rem', fontSize: '1rem' }}
                    >
                      Draw 1 card (-1 AP)
                    </button>
                    {(gameState.players[myId]?.actionPoints ?? 0) < 1 && (
                      <div style={{ color: '#c00' }}>Not enough AP</div>
                    )}
                  </div>
                </>
              )}
              {actionMessage && (
                <div style={{ marginLeft: '1rem', color: '#a00', fontWeight: 'bold' }}>{actionMessage}</div>
              )}
              {justDrew && (
                <div style={{ marginLeft: '1rem', color: '#0a0', fontWeight: 'bold' }}>Drew a card!</div>
              )}
            </div>
          </div>

        </>
      )}

          </main>

          <aside style={{ width: '360px', display: 'flex', flexDirection: 'column', gap: '1rem', flexShrink: 0 }}>
            {gameState?.status === 'in_progress' && (
              <>
                <div style={{ padding: '1rem', border: '1px solid #bbb', borderRadius: '8px', backgroundColor: 'white' }}>
                  <h3>Active Monsters</h3>
                  <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {gameState.activeMonsters.map((monster) => {
                      const template = gameState.cardTemplates[monster.templateId];
                      const requirements = (template?.requirements as Array<{ class?: string; amount?: number }> | undefined) ?? [];
                      const requirementText = requirements.length > 0
                        ? requirements.map((req) => `${req.amount ?? '?'} ${req.class ?? 'Any'}`).join(', ')
                        : 'No requirements';
                      const lowerBound = template?.lowerBound as number | undefined;
                      const lowerBoundText = template?.lowerBoundText as string | undefined;
                      const upperBound = template?.upperBound as number | undefined;
                      const upperBoundText = template?.upperBoundText as string | undefined;
                      return (
                        <div key={monster.instanceId} style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: '#fafafa' }}>
                          <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{template?.name || monster.templateId}</div>
                          <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}>{requirementText}</div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.25rem' }}>
                            <span style={{ fontWeight: 'bold' }}>{lowerBound !== undefined ? `${lowerBound}-` : 'Lower:'}</span>
                            <span style={{ fontSize: '0.85rem', color: '#333' }}>{lowerBoundText ?? 'No lower bound text'}</span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', marginBottom: '0.5rem' }}>
                            <span style={{ fontWeight: 'bold' }}>{upperBound !== undefined ? `${upperBound}-` : 'Upper:'}</span>
                            <span style={{ fontSize: '0.85rem', color: '#333' }}>{upperBoundText ?? 'No upper bound text'}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div style={{ padding: '1rem', border: '1px solid #bbb', borderRadius: '8px', backgroundColor: 'white' }}>
                  <h3>Opponents' Party Leaders</h3>
                  <div style={{ display: 'grid', gap: '0.75rem' }}>
                    {Object.values(gameState.players)
                      .filter((player) => player.id !== myId)
                      .map((player) => {
                        const chosen = player.zones.party[0];
                        const template = chosen ? gameState.cardTemplates[chosen.templateId] : undefined;
                        return (
                          <div key={player.id} style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: '#fafafa' }}>
                            <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{player.username || 'Player'}</div>
                            {chosen ? (
                              <>
                                <div style={{ fontSize: '0.95rem', marginBottom: '0.25rem' }}>{template?.name || chosen.templateId}</div>
                                <div style={{ fontSize: '0.8rem', color: '#666' }}>{chosen.cardType}</div>
                              </>
                            ) : (
                              <div style={{ color: '#999' }}>No leader chosen</div>
                            )}
                            <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#333' }}>
                              Hand size: {player.zones.hand.length}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                </div>
              </>
            )}

            <div style={{ padding: '1rem', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: 'white' }}>
              <h3>Players Connected</h3>
              {players.length === 0 ? (
                <p>No players connected yet.</p>
              ) : (
                players.map((player) => (
                  <p key={player.id}>{player.username || player.id}</p>
                ))
              )}
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}