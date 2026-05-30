import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, GameState, PlayerState } from '../../shared/types';
import './App.css';

export default function Game() {
  const { roomCode: rawRoomCode } = useParams();
  const roomCode = rawRoomCode?.toUpperCase() ?? '';
  const navigate = useNavigate();

  const [name, setName] = useState<string>(localStorage.getItem('username') ?? '');
  const [myId, setMyId] = useState<string>('');
  const [gameState, setGameState] = useState<GameState | null>(null);
  const [isRolling, setIsRolling] = useState(false);
  const [rollAnimationTimer, setRollAnimationTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const [heroRollAnimationTimer, setHeroRollAnimationTimer] = useState<ReturnType<typeof setTimeout> | null>(null);
  const MIN_ROLL_ANIMATION_MS = 3000;

  const getCardTypeLabel = (card: { cardType: string }, template?: Record<string, unknown>) => {
    const typeLabel = card.cardType.charAt(0).toUpperCase() + card.cardType.slice(1);
    const subtype = template?.subtype as string | undefined;
    if (card.cardType === 'item' && subtype) {
      const subtypeText = subtype.charAt(0).toUpperCase() + subtype.slice(1);
      return `${subtypeText} ${typeLabel}s`;
    }
    return typeLabel;
  };

  const findCardInstanceById = (instanceId?: string | null) => {
    if (!instanceId || !gameState) return undefined;
    // search players' zones
    for (const p of Object.values(gameState.players)) {
      for (const zone of ['hand', 'party', 'discardPile'] as const) {
        const found = p.zones[zone].find((c) => c.instanceId === instanceId);
        if (found) return found;
      }
    }
    // search active monsters
    const foundMon = gameState.activeMonsters.find((m) => m.instanceId === instanceId);
    if (foundMon) return foundMon as any;
    // search decks
    const foundMain = gameState.mainDeck.find((c) => c.instanceId === instanceId);
    if (foundMain) return foundMain;
    const foundParty = gameState.partyLeaderDeck.find((c) => c.instanceId === instanceId);
    if (foundParty) return foundParty;
    return undefined;
  };

  const getTemplateForInstanceId = (instanceId?: string | null) => {
    const inst = findCardInstanceById(instanceId);
    if (!inst) return undefined;
    return gameState?.cardTemplates[inst.templateId];
  };
  const [myRoll, setMyRoll] = useState<number | null>(null);
  const [showDrawPrompt, setShowDrawPrompt] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [justDrew, setJustDrew] = useState(false);
  const [selectedHeroId, setSelectedHeroId] = useState<string | null>(null);
  const [selectedHeroLocation, setSelectedHeroLocation] = useState<'hand' | 'party' | null>(null);
  const [heroRollResult, setHeroRollResult] = useState<string | null>(null);
  const [playHeroPromptOpen, setPlayHeroPromptOpen] = useState(false);
  const [pendingHeroPlayId, setPendingHeroPlayId] = useState<string | null>(null);
  const [playHeroRollResult, setPlayHeroRollResult] = useState<string | null>(null);
  const [isHeroRolling, setIsHeroRolling] = useState(false);
  const [selectedOpponentPartyId, setSelectedOpponentPartyId] = useState<string | null>(null);
  const [itemPlayPromptOpen, setItemPlayPromptOpen] = useState(false);
  const [pendingItemPlayId, setPendingItemPlayId] = useState<string | null>(null);
  const [isItemPlaying, setIsItemPlaying] = useState(false);
  const [cursedItemPlayPromptOpen, setCursedItemPlayPromptOpen] = useState(false);
  const [pendingCursedItemPlayId, setPendingCursedItemPlayId] = useState<string | null>(null);
  const [selectedTargetOpponentId, setSelectedTargetOpponentId] = useState<string | null>(null);
  const [isCursedItemPlaying, setIsCursedItemPlaying] = useState(false);
  const [viewedItemId, setViewedItemId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>('Connecting...');
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  useEffect(() => {
    if (!roomCode) {
      setStatus('Missing room code.');
      return;
    }

    const client = io('http://localhost:3001', {
      auth: {
        roomCode,
        username: name || undefined,
      },
    });

    setSocket(client);

    client.on('connect', () => {
      setMyId(client.id ?? '');
      setStatus(`Connected to room ${roomCode}`);
      client.emit('pingServer');
    });

    client.on('pongClient', (data) => {
      console.log('Server says:', data.message);
    });

    client.on('playersUpdated', (connectedPlayers) => {
      setPlayers(connectedPlayers);
    });

    client.on('stateUpdate', (state) => {
      setGameState(state);
      setStatus(`Game status: ${state.status}`);

      const clientId = client.id ?? '';
      setMyRoll(clientId ? state.diceRolls[clientId] ?? null : null);

      if (!rollAnimationTimer) {
        setIsRolling(false);
      }
    });

    client.on('heroRollResult', (result) => {
      console.log("onHeroRollResult: ", result);
      console.log("pendingHeroPlayId: ", pendingHeroPlayId);
      if (result.heroInstanceId === pendingHeroPlayId) {
        console.log("Setting play hero roll result");
        setPlayHeroRollResult(result.message);
      }
      if (result.heroInstanceId === selectedHeroId && selectedHeroLocation === 'party') {
        console.log("Setting hero roll result");
        setHeroRollResult(result.message);
      }
      if (!heroRollAnimationTimer) {
        setIsHeroRolling(false);
      }
      console.log("is hero rolling: ", isHeroRolling);
    });

    client.on('actionFailed', (msg) => {
      console.log("Action failed: ", msg);
      setActionMessage(msg);
      setTimeout(() => setActionMessage(null), 2500);
    });

    client.on('cardDrawn', () => {
      setJustDrew(true);
      setTimeout(() => setJustDrew(false), 800);
    });

    client.on('connect_error', (error) => {
      setStatus(`Unable to join room: ${error.message}`);
    });

    client.on('disconnect', () => {
      setStatus('Disconnected from server.');
    });

    return () => {
      client.off('connect');
      client.off('pongClient');
      client.off('playersUpdated');
      client.off('stateUpdate');
      client.off('actionFailed');
      client.off('cardDrawn');
      client.off('connect_error');
      client.disconnect();
    };
  }, [roomCode]);

  useEffect(() => {
    if (name.trim()) {
      localStorage.setItem('username', name.trim());
      socket?.emit('setUsername', name.trim());
    }
  }, [name, socket]);

  useEffect(() => {
    return () => {
      if (rollAnimationTimer) {
        clearTimeout(rollAnimationTimer);
      }
      if (heroRollAnimationTimer) {
        clearTimeout(heroRollAnimationTimer);
      }
    };
  }, [rollAnimationTimer, heroRollAnimationTimer]);

  const handleStart = () => {
    socket?.emit('startGame');
  };

  const handleRoll = () => {
    if (rollAnimationTimer) {
      clearTimeout(rollAnimationTimer);
    }

    setIsRolling(true);
    const timer = setTimeout(() => {
      setIsRolling(false);
      setRollAnimationTimer(null);
    }, MIN_ROLL_ANIMATION_MS);

    setRollAnimationTimer(timer);
    socket?.emit('rollForFirst');
  };

  const handleContinue = () => {
    socket?.emit('continueGame');
  };

  const handleChoosePartyLeader = (instanceId: string) => {
    if (gameState?.status !== 'party_leader_selection') {
      return;
    }
    socket?.emit('choosePartyLeader', instanceId);
  };

  const handleQuit = () => {
    socket?.emit('quitGame');
  };

  const handleEndTurn = () => {
    socket?.emit('endTurn');
  };

  const handlePlayHero = (instanceId: string) => {
    if (!gameState || gameState.status !== 'in_progress') {
      return;
    }
    socket?.emit('playHero', instanceId);
    setSelectedHeroId(instanceId);
    setSelectedHeroLocation('hand');
    setHeroRollResult(null);
    setPendingHeroPlayId(instanceId);
    setPlayHeroPromptOpen(true);
    setPlayHeroRollResult(null);
  };

  const confirmPlayHero = () => {
    setPendingHeroPlayId(null);
    setPlayHeroPromptOpen(false);
  };

  const handlePlayHeroRoll = () => {
    if (!gameState || !pendingHeroPlayId) {
      return;
    }

    if (heroRollAnimationTimer) {
      console.log("clearing heroRollAnimationTimer");
      clearTimeout(heroRollAnimationTimer);
    }

    setIsHeroRolling(true);
    setPlayHeroRollResult(null);
    const timer = setTimeout(() => {
      setIsHeroRolling(false);
      setHeroRollAnimationTimer(null);
    }, MIN_ROLL_ANIMATION_MS);

    console.log("timer: ", timer);

    setHeroRollAnimationTimer(timer);

    console.log("hero roll animation timer: ", heroRollAnimationTimer);

    socket?.emit('rollHeroAbility', pendingHeroPlayId);
  };

  const handleSkipPlayHeroRoll = () => {
    if (!pendingHeroPlayId) {
      return;
    }
    setPlayHeroRollResult('Skipped ability roll and played the hero.');
    confirmPlayHero();
  };

  

  const handleConfirmPlayItem = (targetHeroInstanceId: string) => {
    if (!pendingItemPlayId) return;
    // send to server: itemInstanceId, targetHeroInstanceId
    socket?.emit('playItem', pendingItemPlayId, targetHeroInstanceId);
    setItemPlayPromptOpen(false);
    setPendingItemPlayId(null);
    setIsItemPlaying(false);
  };

  const handleCancelPlayItem = () => {
    setItemPlayPromptOpen(false);
    setPendingItemPlayId(null);
  };

  const handleInitiateCursedItemPlay = (instanceId: string) => {
    if (!gameState || gameState.status !== 'in_progress') return;
    setPendingCursedItemPlayId(instanceId);
    setSelectedTargetOpponentId(null);
    setCursedItemPlayPromptOpen(true);
    setViewedItemId(null);
  };

  const handleConfirmCursedItemPlay = (targetHeroInstanceId: string) => {
    if (!pendingCursedItemPlayId || !selectedTargetOpponentId) return;
    socket?.emit('playCursedItem', pendingCursedItemPlayId, selectedTargetOpponentId, targetHeroInstanceId);
    setCursedItemPlayPromptOpen(false);
    setPendingCursedItemPlayId(null);
    setSelectedTargetOpponentId(null);
    setIsCursedItemPlaying(false);
  };

  const handleCancelCursedItemPlay = () => {
    if (selectedTargetOpponentId) {
      setSelectedTargetOpponentId(null);
    } else {
      setCursedItemPlayPromptOpen(false);
      setPendingCursedItemPlayId(null);
    }
  };

  const handleRollHeroAbility = () => {
    if (!gameState || !selectedHeroId || selectedHeroLocation !== 'party') {
      return;
    }

    setIsHeroRolling(true);
    setHeroRollResult(null);
    socket?.emit('rollHeroAbility', selectedHeroId);
  };

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setStatus('Please enter a username');
      return;
    }
    localStorage.setItem('username', trimmed);
    setStatus(`Username set to ${trimmed}`);
    socket?.emit('setUsername', trimmed);
  };

  if (!roomCode) {
    return (
      <div className="appShell">
        <div className="appPage">
          <h1>Invalid room</h1>
          <p>No room code was provided.</p>
          <button type="button" onClick={() => navigate('/')}>Go Home</button>
        </div>
      </div>
    );
  }

  const myPlayer = gameState?.players[myId];
  const selectedHero = myPlayer?.zones.hand.find((card) => card.instanceId === selectedHeroId)
    ?? myPlayer?.zones.party.find((card) => card.instanceId === selectedHeroId);
  const selectedHeroAP = selectedHeroLocation === 'hand' ? myPlayer?.actionPoints ?? 0 : 0;

  return (
    <div className="appShell" onClick={() => setSelectedHeroId(null)}>
      <style>{`@keyframes spin {0% { transform: rotateX(0deg) rotateY(0deg); }100% { transform: rotateX(360deg) rotateY(360deg); }}`}</style>
      <div className="appPage">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', flexWrap: 'wrap', gap: '1rem' }}>
          <div>
            <h1>Room {roomCode}</h1>
            <p>Status: <strong>{status}</strong></p>
          </div>
          <div>
            <button type="button" onClick={() => navigate('/')} className="primaryButton">
              Back to Home
            </button>
          </div>
        </div>

        <div style={{ marginBottom: '1.5rem', maxWidth: '720px' }}>
          <form onSubmit={handleSubmit} style={{ marginBottom: '1rem' }}>
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
            <button type="submit" style={{ marginTop: '0.75rem', padding: '0.5rem 1rem', fontSize: '1rem' }}>
              Save Username
            </button>
          </form>

          {actionMessage && <div style={{ color: '#c00', marginBottom: '1rem' }}>{actionMessage}</div>}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', minHeight: 'calc(100vh - 260px)' }}>
          <main className="mainContent">
            {gameState?.status === 'waiting' && gameState?.lobbyLeaderId === myId && (
              <button type="button" onClick={handleStart} style={{ marginBottom: '1.5rem', padding: '0.5rem 1rem', fontSize: '1rem' }}>
                Start Game
              </button>
            )}

            {gameState?.status === 'waiting' && gameState?.lobbyLeaderId !== myId && (
              <p style={{ marginBottom: '1.5rem', color: '#666' }}>
                Waiting for {gameState.lobbyLeaderId ? gameState.players[gameState.lobbyLeaderId]?.username : 'the lobby leader'} to start the game...
              </p>
            )}

            {gameState?.status === 'rolling' && (
              <div className="panel panelAccentBlue">
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
                    {itemPlayPromptOpen && pendingItemPlayId && (
                      <div style={{ marginTop: '1rem', padding: '1rem', border: '1px dashed #28a745', borderRadius: '8px', backgroundColor: '#f1fff4' }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ marginBottom: '0.5rem', fontWeight: 'bold' }}>Choose a hero to equip this item to (cost: 1 AP)</div>
                        <div style={{ display: 'grid', gap: '0.5rem' }}>
                          {gameState.players[myId].zones.party.filter((c) => c.cardType === 'hero').length > 0 ? (
                            gameState.players[myId].zones.party.filter((c) => c.cardType === 'hero').map((hero) => {
                              const t = gameState.cardTemplates[hero.templateId];
                              return (
                                <div key={hero.instanceId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                                  <div>
                                    <div style={{ fontWeight: 'bold' }}>{t?.name || hero.templateId}</div>
                                    <div style={{ fontSize: '0.85rem', color: '#666' }}>{(t?.abilityText as string) || ''}</div>
                                  </div>
                                  <div>
                                    <button
                                      type="button"
                                      onClick={() => handleConfirmPlayItem(hero.instanceId)}
                                      disabled={(gameState.players[myId]?.actionPoints ?? 0) < 1 || isItemPlaying}
                                      style={{ padding: '0.4rem 0.6rem', backgroundColor: (gameState.players[myId]?.actionPoints ?? 0) < 1 || isItemPlaying ? '#ccc' : '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: (gameState.players[myId]?.actionPoints ?? 0) < 1 || isItemPlaying ? 'not-allowed' : 'pointer' }}
                                    >
                                      Equip
                                    </button>
                                  </div>
                                </div>
                              );
                            })
                          ) : (
                            <div style={{ color: '#666' }}>You have no heroes in your party to equip.</div>
                          )}
                        </div>
                        <div style={{ marginTop: '0.75rem' }}>
                          <button type="button" onClick={handleCancelPlayItem} style={{ padding: '0.4rem 0.6rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {cursedItemPlayPromptOpen && pendingCursedItemPlayId && (
                      <div style={{ marginTop: '1rem', padding: '1rem', border: '1px dashed #dc3545', borderRadius: '8px', backgroundColor: '#fff1f2' }} onClick={(e) => e.stopPropagation()}>
                        <div style={{ marginBottom: '0.75rem', fontWeight: 'bold' }}>Choose an opponent and hero to target with this cursed item (cost: 1 AP)</div>
                        <div style={{ display: 'grid', gap: '0.75rem' }}>
                          {Object.entries(gameState.players).filter(([playerId]) => playerId !== myId).length > 0 ? (
                            Object.entries(gameState.players).filter(([playerId]) => playerId !== myId).map(([playerId, opponent]) => {
                              const isSelected = selectedTargetOpponentId === playerId;
                              return (
                                <div key={playerId} style={{ padding: '0.75rem', border: `1px solid ${isSelected ? '#dc3545' : '#ddd'}`, borderRadius: '8px', backgroundColor: isSelected ? '#ffe5e9' : 'white' }}>
                                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
                                    <div style={{ fontWeight: 'bold' }}>{opponent.username || 'Opponent'}</div>
                                    <button
                                      type="button"
                                      onClick={() => setSelectedTargetOpponentId(playerId)}
                                      style={{ padding: '0.3rem 0.5rem', backgroundColor: isSelected ? '#bd2130' : '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                                    >
                                      {isSelected ? 'Selected' : 'Target'}
                                    </button>
                                  </div>
                                  {isSelected ? (
                                    <div style={{ display: 'grid', gap: '0.5rem' }}>
                                      {opponent.zones.party.filter((c) => c.cardType === 'hero').length > 0 ? (
                                        opponent.zones.party.filter((c) => c.cardType === 'hero').map((hero) => {
                                          const t = gameState.cardTemplates[hero.templateId];
                                          return (
                                            <div key={hero.instanceId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem', border: '1px solid #ddd', borderRadius: '6px', backgroundColor: '#fff' }}>
                                              <div>
                                                <div style={{ fontWeight: 'bold' }}>{t?.name || hero.templateId}</div>
                                                <div style={{ fontSize: '0.85rem', color: '#666' }}>{(t?.abilityText as string) || ''}</div>
                                              </div>
                                              <button
                                                type="button"
                                                onClick={() => handleConfirmCursedItemPlay(hero.instanceId)}
                                                disabled={(gameState.players[myId]?.actionPoints ?? 0) < 1 || isCursedItemPlaying}
                                                style={{ padding: '0.4rem 0.6rem', backgroundColor: (gameState.players[myId]?.actionPoints ?? 0) < 1 || isCursedItemPlaying ? '#ccc' : '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: (gameState.players[myId]?.actionPoints ?? 0) < 1 || isCursedItemPlaying ? 'not-allowed' : 'pointer' }}
                                              >
                                                Curse
                                              </button>
                                            </div>
                                          );
                                        })
                                      ) : (
                                        <div style={{ color: '#666' }}>This opponent has no heroes in their party.</div>
                                      )}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })
                          ) : (
                            <div style={{ color: '#666' }}>No opponents available to target.</div>
                          )}
                        </div>
                        <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem' }}>
                          <button type="button" onClick={handleCancelCursedItemPlay} style={{ padding: '0.4rem 0.6rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}>Cancel</button>
                          <button type="button" onClick={() => setCursedItemPlayPromptOpen(false)} style={{ padding: '0.4rem 0.6rem', backgroundColor: '#f8d7da', color: '#721c24', border: '1px solid #f5c6cb', borderRadius: '4px' }}>Back</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <style>{`@keyframes spin {0% { transform: rotateX(0deg) rotateY(0deg); }100% { transform: rotateX(360deg) rotateY(360deg); }}`}</style>
              </div>
            )}

            {gameState?.status === 'roll_complete' && (
              <div className="panel panelAccentGreen">
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
                  <button type="button" onClick={handleContinue} style={{ padding: '0.75rem 1.5rem', fontSize: '1.1rem', backgroundColor: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
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
              <div className="panel panelAccentPurple">
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
                      <div style={{ marginTop: '0.5rem', opacity: 0.85 }}>Face Down</div>
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
              <div className="panel panelAccentGreen">
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
                            <div style={{ fontSize: '0.8rem', color: '#666' }}>{getCardTypeLabel(chosen, template)}</div>
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
                  <button type="button" onClick={handleContinue} style={{ padding: '0.75rem 1.5rem', fontSize: '1.1rem', backgroundColor: '#20c997', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>
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
              <button type="button" onClick={handleQuit} style={{ marginBottom: '1.5rem', padding: '0.5rem 1rem', fontSize: '1rem', backgroundColor: '#ff6b6b', color: 'white' }}>
                Quit Game
              </button>
            )}
            {gameState && (
              <p>Current game status: <strong>{gameState.status}</strong></p>
            )}

            {gameState?.status === 'in_progress' && (
              <div className="panel statusPanel">
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
                <div className="boardTopRow">
                  {gameState.players[myId].zones.party[0] && (() => {
                    const partyLeader = gameState.players[myId].zones.party[0];
                    const template = gameState.cardTemplates[partyLeader.templateId];
                    const cardName = template?.name || partyLeader.templateId;
                    const abilityText = (template?.abilityText as string) || '';
                    return (
                      <div style={{ width: '220px', padding: '1rem', border: '2px solid #333', borderRadius: '8px', backgroundColor: '#faf7f0' }}>
                        <h3 style={{ marginTop: 0 }}>Your Party Leader</h3>
                        <div style={{ fontSize: '1rem', fontWeight: 'bold', marginBottom: '0.5rem' }}>{cardName}</div>
                        <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.75rem' }}>{getCardTypeLabel(partyLeader, template)}</div>
                        {abilityText && (
                          <div style={{ fontSize: '0.8rem', color: '#333', lineHeight: '1.4' }}>{abilityText}</div>
                        )}
                      </div>
                    );
                  })()}

                  <div className="panel panelParty">
                    <h3 style={{ marginTop: 0 }}>Your Party</h3>
                    <div style={{ minHeight: '120px', display: 'grid', gap: '0.75rem' }}>
                      {gameState.players[myId].zones.party.filter((card) => card.cardType === 'hero').length > 0 ? (
                        gameState.players[myId].zones.party
                          .filter((card) => card.cardType === 'hero')
                          .map((card) => {
                            const template = gameState.cardTemplates[card.templateId];
                            const rollToPlay = template?.rollToPlay as number | undefined;
                            const equippedTemplate = getTemplateForInstanceId(card.equippedItem);
                            return (
                              <div
                                key={card.instanceId}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  setSelectedHeroId(card.instanceId);
                                  setSelectedHeroLocation('party');
                                  setHeroRollResult(null);
                                }}
                                className={`card ${selectedHeroId === card.instanceId ? 'cardSelected' : ''} ${card.cardType === 'hero' ? 'cardHero' : ''}`}
                                style={{ padding: '0.75rem', border: '1px solid #333', borderRadius: '6px', backgroundColor: '#f7f7ff', cursor: 'pointer' }}
                              >
                                <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{template?.name || card.templateId}</div>
                                <div style={{ fontSize: '0.8rem', color: '#666' }}>{template?.class || 'Hero'}</div>
                                {rollToPlay !== undefined && (
                                  <div style={{ fontSize: '0.75rem', color: '#444', marginTop: '0.5rem' }}>
                                    Roll to use: +{rollToPlay}
                                  </div>
                                )}
                                {card.equippedItem && (
                                  <div style={{ marginTop: '0.5rem' }}>
                                    <div style={{ fontSize: '0.75rem', color: '#333' }}>
                                      Equipped: <button type="button" onClick={(e) => { e.stopPropagation(); setViewedItemId(card.equippedItem ?? null); }} style={{ background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', padding: 0 }}>{equippedTemplate?.name || 'Item'}</button>
                                    </div>
                                    {viewedItemId === card.equippedItem && equippedTemplate && (
                                      <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: '6px' }}>
                                        <div style={{ fontWeight: 'bold' }}>{equippedTemplate.name}</div>
                                        <div style={{ fontSize: '0.85rem', color: '#666' }}>{(equippedTemplate as any).type || ''}</div>
                                        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#333' }}>{((equippedTemplate as any).abilityText as string) || ''}</div>
                                        <div style={{ marginTop: '0.5rem' }}>
                                          <button type="button" onClick={() => setViewedItemId(null)} style={{ padding: '0.25rem 0.5rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}>Close</button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                      ) : (
                        <div style={{ color: '#666' }}>Play hero cards from your hand to your party.</div>
                      )}
                    </div>
                  </div>

                  <div className="panel panelHand">
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
                                setSelectedHeroLocation('hand');
                                setHeroRollResult(null);
                              }
                              if (card.cardType === 'item') {
                                const isCursed = (template?.subtype as string | undefined)?.toLowerCase() === 'cursed';
                                if (isCursed) {
                                  handleInitiateCursedItemPlay(card.instanceId);
                                } else {
                                  // start regular item play flow
                                  setPendingItemPlayId(card.instanceId);
                                  setItemPlayPromptOpen(true);
                                  setViewedItemId(null);
                                }
                              }
                            }}
                            className={`card ${selectedHeroId === card.instanceId ? 'cardSelected' : ''} ${card.cardType === 'hero' ? 'cardHero' : ''}`}
                          >
                            <div style={{ fontSize: '0.85rem', fontWeight: 'bold' }}>{cardName}</div>
                            <div style={{ fontSize: '0.7rem', color: '#666', marginTop: '0.25rem' }}>
                              {getCardTypeLabel(card, template)}
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
                            {card.cardType === 'item' && (
                              <button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  const isCursed = (template?.subtype as string | undefined)?.toLowerCase() === 'cursed';
                                  if (isCursed) {
                                    handleInitiateCursedItemPlay(card.instanceId);
                                  } else {
                                    setPendingItemPlayId(card.instanceId);
                                    setItemPlayPromptOpen(true);
                                    setViewedItemId(null);
                                  }
                                }}
                                style={{ marginTop: '0.75rem', padding: '0.45rem 0.75rem', fontSize: '0.8rem', backgroundColor: '#007bff', color: 'white', border: 'none', borderRadius: '6px', cursor: 'pointer' }}
                              >
                                Use Item
                              </button>
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
                        <div style={{ marginBottom: '0.75rem', color: '#333' }}>
                          {(gameState.cardTemplates[selectedHero.templateId]?.abilityText as string) || 'No ability text available.'}
                        </div>
                        {selectedHeroLocation === 'hand' ? (
                          <>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handlePlayHero(selectedHero.instanceId);
                              }}
                              disabled={selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId)}
                              style={{
                                padding: '0.75rem 1.25rem',
                                fontSize: '1rem',
                                backgroundColor: selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId) ? '#ccc' : '#007bff',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: selectedHeroAP < 1 || (playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId) ? 'not-allowed' : 'pointer',
                              }}
                            >
                              {playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId ? 'Waiting for roll decision…' : 'Play Hero (-1 AP)'}
                            </button>
                            {selectedHeroAP < 1 && (
                              <div style={{ marginTop: '0.75rem', color: '#c00' }}>
                                You need at least 1 AP to play this hero.
                              </div>
                            )}
                            {playHeroPromptOpen && pendingHeroPlayId === selectedHero.instanceId && (
                              <div style={{ marginTop: '1rem', padding: '1rem', border: '1px dashed #007bff', borderRadius: '8px', backgroundColor: '#eef5ff' }}>
                                {!isHeroRolling && (
                                  <div style={{ marginBottom: '0.75rem' }}>
                                    Would you like to roll for this hero's ability before playing it?
                                  </div>
                                )}
                                {!isHeroRolling && (
                                  <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handlePlayHeroRoll();
                                      }}
                                      disabled={isHeroRolling}
                                      style={{ padding: '0.75rem 1.25rem', fontSize: '1rem', backgroundColor: isHeroRolling ? '#ccc' : '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: isHeroRolling ? 'not-allowed' : 'pointer' }}
                                    >
                                      Roll Ability
                                    </button>
                                    <button
                                      type="button"
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        handleSkipPlayHeroRoll();
                                      }}
                                      disabled={isHeroRolling}
                                      style={{ padding: '0.75rem 1.25rem', fontSize: '1rem', backgroundColor: isHeroRolling ? '#ccc' : '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: isHeroRolling ? 'not-allowed' : 'pointer' }}
                                    >
                                      Don't Roll
                                    </button>
                                  </div>
                                )}
                                {isHeroRolling && (
                                  <div style={{ fontSize: '2rem', marginTop: '1rem', animation: 'spin 0.1s infinite' }}>
                                    🎲 🎲
                                  </div>
                                )}
                                {playHeroRollResult && (
                                  <div style={{ marginTop: '0.75rem', color: '#333' }}>
                                    {playHeroRollResult}
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        ) : selectedHeroLocation === 'party' ? (
                          <>
                            <button
                              type="button"
                              onClick={(event) => {
                                event.stopPropagation();
                                handleRollHeroAbility();
                              }}
                              style={{
                                padding: '0.75rem 1.25rem',
                                fontSize: '1rem',
                                backgroundColor: '#007bff',
                                color: 'white',
                                border: 'none',
                                borderRadius: '4px',
                                cursor: 'pointer',
                              }}
                            >
                              Roll for Hero Ability
                            </button>
                            {heroRollResult && (
                              <div style={{ marginTop: '0.75rem', color: '#333' }}>
                                {heroRollResult}
                              </div>
                            )}
                          </>
                        ) : null}
                      </div>
                    )}
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
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                        <button
                          onClick={() => {
                            const myAP = gameState.players[myId]?.actionPoints ?? 0;
                            if (myAP >= 1) {
                              socket?.emit('drawFromMain');
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

          <aside className="sidebar">
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
                      const slainEffectText = template?.slainEffectText as string | undefined;
                      return (
                        <div key={monster.instanceId} style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: '#fafafa' }}>
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
                            <div style={{ marginTop: '0.5rem', padding: '0.75rem', borderRadius: '6px', backgroundColor: '#fff8e1', color: '#333' }}>
                              <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Slain Effect</div>
                              <div style={{ fontSize: '0.8rem' }}>{slainEffectText}</div>
                            </div>
                          )}
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
                            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '0.75rem' }}>
                              <div>
                                <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{player.username || 'Player'}</div>
                                {chosen ? (
                                  <>
                                    <div style={{ fontSize: '0.95rem', marginBottom: '0.25rem' }}>{template?.name || chosen.templateId}</div>
                                    <div style={{ fontSize: '0.8rem', color: '#666' }}>{getCardTypeLabel(chosen, template)}</div>
                                  </>
                                ) : (
                                  <div style={{ color: '#999' }}>No leader chosen</div>
                                )}
                              </div>
                              <button
                                type="button"
                                onClick={() => setSelectedOpponentPartyId((current) => current === player.id ? null : player.id)}
                                style={{ padding: '0.5rem 0.75rem', backgroundColor: selectedOpponentPartyId === player.id ? '#6c757d' : '#007bff', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                              >
                                {selectedOpponentPartyId === player.id ? 'Hide Party' : 'View Party'}
                              </button>
                            </div>
                            <div style={{ marginTop: '0.75rem', fontSize: '0.85rem', color: '#333' }}>
                              Hand size: {player.zones.hand.length}
                            </div>
                          </div>
                        );
                      })}
                  </div>
                  {selectedOpponentPartyId && gameState.players[selectedOpponentPartyId] && (
                    <div style={{ marginTop: '1rem', padding: '1rem', border: '1px solid #007bff', borderRadius: '8px', backgroundColor: '#eef5ff' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem', marginBottom: '0.75rem' }}>
                        <div>
                          <div style={{ fontWeight: 'bold', fontSize: '1rem' }}>{gameState.players[selectedOpponentPartyId].username || 'Player'}'s Party</div>
                          <div style={{ fontSize: '0.85rem', color: '#555' }}>Party size: {gameState.players[selectedOpponentPartyId].zones.party.length}</div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setSelectedOpponentPartyId(null)}
                          style={{ padding: '0.5rem 0.75rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}
                        >
                          Close
                        </button>
                      </div>
                      <div style={{ display: 'grid', gap: '0.75rem' }}>
                        {gameState.players[selectedOpponentPartyId].zones.party.length > 0 ? (
                          gameState.players[selectedOpponentPartyId].zones.party.map((card) => {
                            const template = gameState.cardTemplates[card.templateId];
                            const abilityText = (template?.abilityText as string) || '';
                            const rollToPlay = template?.rollToPlay as number | undefined;
                            const equippedTemplate = getTemplateForInstanceId(card.equippedItem);
                            return (
                              <div key={card.instanceId} style={{ padding: '0.75rem', border: '1px solid #ddd', borderRadius: '8px', backgroundColor: 'white' }}>
                                <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>{template?.name || card.templateId}</div>
                                <div style={{ fontSize: '0.8rem', color: '#666', marginBottom: '0.5rem' }}>{getCardTypeLabel(card, template)}</div>
                                {abilityText && (
                                  <div style={{ fontSize: '0.8rem', color: '#333', marginBottom: '0.5rem' }}>{abilityText}</div>
                                )}
                                {rollToPlay !== undefined && (
                                  <div style={{ fontSize: '0.8rem', color: '#333' }}>Roll to play: +{rollToPlay}</div>
                                )}
                                {card.equippedItem && (
                                  <div style={{ marginTop: '0.5rem' }}>
                                    <div style={{ fontSize: '0.85rem', color: '#333' }}>
                                      Equipped: <button type="button" onClick={() => setViewedItemId(card.equippedItem ?? null)} style={{ background: 'none', border: 'none', color: '#007bff', cursor: 'pointer', padding: 0 }}>{equippedTemplate?.name || 'Item'}</button>
                                    </div>
                                    {viewedItemId === card.equippedItem && equippedTemplate && (
                                      <div style={{ marginTop: '0.5rem', padding: '0.5rem', backgroundColor: '#fff', border: '1px solid #ddd', borderRadius: '6px' }}>
                                        <div style={{ fontWeight: 'bold' }}>{equippedTemplate.name}</div>
                                        <div style={{ fontSize: '0.85rem', color: '#666' }}>{(equippedTemplate as any).type || ''}</div>
                                        <div style={{ marginTop: '0.5rem', fontSize: '0.85rem', color: '#333' }}>{((equippedTemplate as any).abilityText as string) || ''}</div>
                                        <div style={{ marginTop: '0.5rem' }}>
                                          <button type="button" onClick={() => setViewedItemId(null)} style={{ padding: '0.25rem 0.5rem', backgroundColor: '#6c757d', color: 'white', border: 'none', borderRadius: '4px' }}>Close</button>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            );
                          })
                        ) : (
                          <div style={{ color: '#666' }}>No party cards to display.</div>
                        )}
                      </div>
                    </div>
                  )}
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
