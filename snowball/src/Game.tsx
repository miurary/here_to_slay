import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents, GameState, PlayerState } from '../../shared/types';
import './App.css';

import FirstRollCard from './components/game/FirstRollCard';
import GameStatusCard from './components/game/GameStatusCard';
import HandCard from './components/game/HandCard';
import PartyCard from './components/game/PartyCard';
import PartyLeaderCard from './components/game/PartyLeaderCard';
import PartyLeaderSelectionCard from './components/game/PartyLeaderSelectionCard';
import PartyLeaderReviewCard from './components/game/PartyLeaderReviewCard';
import RollCompleteCard from './components/game/RollCompleteCard';

import { getCardTypeLabel, getTemplateForInstanceId } from './utils/gameUtils';

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
              <FirstRollCard
                gameState={gameState}
                myId={myId}
                handleRoll={handleRoll}
                isRolling={isRolling}
                myRoll={myRoll}
              />
            )}

            {gameState?.status === 'roll_complete' && (
              <RollCompleteCard
                gameState={gameState}
                myId={myId}
                handleContinue={handleContinue}
              />
            )}

            {gameState?.status === 'party_leader_selection' && (
              <PartyLeaderSelectionCard
                gameState={gameState}
                myId={myId}
                handleChoosePartyLeader={handleChoosePartyLeader}
              />
            )}

            {gameState?.status === 'party_leader_review' && (
              <PartyLeaderReviewCard
                gameState={gameState}
                myId={myId}
                handleContinue={handleContinue}
              />
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
              <GameStatusCard
                gameState={gameState}
                myId={myId}
              />
            )}

            {gameState && gameState.status === 'in_progress' && gameState.players[myId] && (
              <>
                <div className="boardTopRow">
                  <PartyLeaderCard gameState={gameState} myId={myId} />

                  <PartyCard
                    gameState={gameState} 
                    myId={myId}
                    selectedHeroId={selectedHeroId}
                    setSelectedHeroId={setSelectedHeroId}
                    viewedItemId={viewedItemId}
                    setViewedItemId={setViewedItemId}
                    setSelectedHeroLocation={setSelectedHeroLocation}
                    setHeroRollResult={setHeroRollResult}
                  />

                  <HandCard
                    gameState={gameState}
                    myId={myId}
                    selectedHeroId={selectedHeroId}
                    setSelectedHeroId={setSelectedHeroId}
                    setViewedItemId={setViewedItemId}
                    setSelectedHeroLocation={setSelectedHeroLocation}
                    setHeroRollResult={setHeroRollResult}
                    handlePlayHero={handlePlayHero}
                    handleInitiateCursedItemPlay={handleInitiateCursedItemPlay}
                    setPendingItemPlayId={setPendingItemPlayId}
                    setItemPlayPromptOpen={setItemPlayPromptOpen}
                    pendingHeroPlayId={pendingHeroPlayId}
                    selectedHero={selectedHero}
                    selectedHeroLocation={selectedHeroLocation}
                    heroRollResult={heroRollResult}
                    playHeroPromptOpen={playHeroPromptOpen}
                    isHeroRolling={isHeroRolling}
                    selectedHeroAP={selectedHeroAP}
                    handlePlayHeroRoll={handlePlayHeroRoll}
                    handleSkipPlayHeroRoll={handleSkipPlayHeroRoll}
                    handleRollHeroAbility={handleRollHeroAbility}
                    playHeroRollResult={playHeroRollResult}
                  />
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
                            const equippedTemplate = getTemplateForInstanceId(gameState, card.equippedItem);
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
