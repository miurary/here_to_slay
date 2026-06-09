import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import type { AbilityPrompt, ChallengeResolvedData, ClientToServerEvents, ServerToClientEvents, GameState, CardInstance, PlayerState, MonsterAttackResultData } from '../../shared/types';
import './App.css';

import FirstRollCard from './components/game/FirstRollCard';
import GameStatusCard from './components/game/GameStatusCard';
import HandCard from './components/game/HandCard';
import PartyCard from './components/game/PartyCard';
import PartyLeaderCard from './components/game/PartyLeaderCard';
import PartyLeaderSelectionCard from './components/game/PartyLeaderSelectionCard';
import PartyLeaderReviewCard from './components/game/PartyLeaderReviewCard';
import RollCompleteCard from './components/game/RollCompleteCard';
import EndTurnButton from './components/game/EndTurnButton';
import MainDeckCard from './components/game/MainDeckCard';
import DiscardPileCard from './components/game/DiscardPileCard';
import ActiveMonstersSidebarCard from './components/game/ActiveMonstersSidebarCard';
import OpponentInformationCard from './components/game/OpponentInformationCard';

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
  const [showDiscardPile, setShowDiscardPile] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [justDrew, setJustDrew] = useState(false);
  const [selectedHeroId, setSelectedHeroId] = useState<string | null>(null);
  const [selectedHeroLocation, setSelectedHeroLocation] = useState<'hand' | 'party' | null>(null);
  const [heroRollResult, setHeroRollResult] = useState<string | null>(null);
  const [playHeroPromptOpen, setPlayHeroPromptOpen] = useState(false);
  const [pendingHeroPlayId, setPendingHeroPlayId] = useState<string | null>(null);
  const [pendingHeroAbilityActivationId, setPendingHeroAbilityActivationId] = useState<string | null>(null);
  const [abilityPrompt, setAbilityPrompt] = useState<AbilityPrompt | null>(null);
  const [playHeroRollResult, setPlayHeroRollResult] = useState<string | null>(null);
  const [isHeroRolling, setIsHeroRolling] = useState(false);
  const pendingHeroPlayIdRef = useRef<string | null>(pendingHeroPlayId);
  const selectedHeroIdRef = useRef<string | null>(selectedHeroId);
  const selectedHeroLocationRef = useRef<'hand' | 'party' | null>(selectedHeroLocation);
  const heroRollAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(heroRollAnimationTimer);
  const isHeroRollingRef = useRef<boolean>(isHeroRolling);
  const playHeroPromptOpenRef = useRef<boolean>(playHeroPromptOpen);
  const [selectedOpponentPartyId, setSelectedOpponentPartyId] = useState<string | null>(null);
  const [itemPlayPromptOpen, setItemPlayPromptOpen] = useState(false);
  const [pendingItemPlayId, setPendingItemPlayId] = useState<string | null>(null);
  const [cursedItemPlayPromptOpen, setCursedItemPlayPromptOpen] = useState(false);
  const [pendingCursedItemPlayId, setPendingCursedItemPlayId] = useState<string | null>(null);
  const [selectedTargetOpponentId, setSelectedTargetOpponentId] = useState<string | null>(null);
  const [viewedItemId, setViewedItemId] = useState<string | null>(null);
  const [challengeResult, setChallengeResult] = useState<ChallengeResolvedData | null>(null);
  const [monsterAttackResult, setMonsterAttackResult] = useState<MonsterAttackResultData | null>(null);
  const [selectedMonsterId, setSelectedMonsterId] = useState<string | null>(null);
  const [status, setStatus] = useState<string>(!roomCode ? 'Missing room code.' : 'Connecting...');
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);

  useEffect(() => {
    pendingHeroPlayIdRef.current = pendingHeroPlayId;
    selectedHeroIdRef.current = selectedHeroId;
    selectedHeroLocationRef.current = selectedHeroLocation;
    heroRollAnimationTimerRef.current = heroRollAnimationTimer;
    isHeroRollingRef.current = isHeroRolling;
    playHeroPromptOpenRef.current = playHeroPromptOpen;
  }, [pendingHeroPlayId, selectedHeroId, selectedHeroLocation, heroRollAnimationTimer, isHeroRolling, playHeroPromptOpen]);

  useEffect(() => {
    if (!roomCode) return;

    const client = io(`${import.meta.env.VITE_API_URL}`, {
      withCredentials: true,
      auth: {
        roomCode,
        username: name || undefined,
      },
    });

    // eslint-disable-next-line react-hooks/set-state-in-effect
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

    client.on('stateUpdate', (state: GameState) => {
      setGameState(state);
      setStatus(`Game status: ${state.status}`);

      const clientId = client.id ?? '';
      setMyRoll(clientId ? state.diceRolls[clientId] ?? null : null);

      if (!rollAnimationTimer) {
        setIsRolling(false);
      }

      // If a hero was just played via ability and is now in the party, show roll prompt
      const pendingId = pendingHeroPlayIdRef.current;
      if (pendingId) {
        const myPlayer = state.players[clientId];
        if (myPlayer) {
          const heroInParty = myPlayer.zones.party.find((card) => card.instanceId === pendingId);
          if (heroInParty && !playHeroPromptOpenRef.current) {
            setSelectedHeroId(pendingId);
            setSelectedHeroLocation('party');
            setHeroRollResult(null);
          }
        }
      }
    });

    client.on('heroRollResult', (result) => {
      console.log("onHeroRollResult: ", result);
      console.log("pendingHeroPlayId: ", pendingHeroPlayIdRef.current);
      if (result.heroInstanceId === pendingHeroPlayIdRef.current) {
        console.log("Setting play hero roll result");
        setPlayHeroRollResult(result.message);
        setPendingHeroAbilityActivationId(result.success ? result.heroInstanceId : null);
      }
      if (result.heroInstanceId === selectedHeroIdRef.current && selectedHeroLocationRef.current === 'party') {
        console.log("Setting hero roll result");
        setHeroRollResult(result.message);
        setPendingHeroAbilityActivationId(result.success ? result.heroInstanceId : null);
      }
      if (!heroRollAnimationTimerRef.current) {
        setIsHeroRolling(false);
      }
      console.log("is hero rolling: ", isHeroRollingRef.current);
    });
    client.on('abilityPrompt', (prompt) => {
      setAbilityPrompt(prompt);
      setActionMessage(null);
    });
    client.on('abilityResolution', (data) => {
      setActionMessage(data.message);
      setAbilityPrompt(null);
      setPendingHeroAbilityActivationId(null);
    });

    client.on('heroPlayedFromAbility', (heroInstanceId: string) => {
      setPendingHeroPlayId(heroInstanceId);
    });

    client.on('playerDiscarded', (data: { playerId: string; playerName?: string; cardInstanceId: string; cardName?: string }) => {
      setActionMessage(`${data.playerName || 'A player'} discarded ${data.cardName || data.cardInstanceId}`);
      setTimeout(() => setActionMessage(null), 3000);
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

    client.on('heroPlayAccepted', (heroInstanceId: string) => {
      setPendingHeroPlayId(heroInstanceId);
      setSelectedHeroId(heroInstanceId);
      setSelectedHeroLocation('hand');
      setHeroRollResult(null);
      setPlayHeroPromptOpen(true);
      setPlayHeroRollResult(null);
    });

    client.on('challengeResolved', (data: ChallengeResolvedData) => {
      setChallengeResult(data);
      setTimeout(() => setChallengeResult(null), 6000);
    });

    client.on('monsterAttackResult', (data: MonsterAttackResultData) => {
      setMonsterAttackResult(data);
      setTimeout(() => setMonsterAttackResult(null), 7000);
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
      client.off('heroRollResult');
      client.off('abilityPrompt');
      client.off('abilityResolution');
      client.off('heroPlayedFromAbility');
      client.off('playerDiscarded');
      client.off('actionFailed');
      client.off('cardDrawn');
      client.off('heroPlayAccepted');
      client.off('challengeResolved');
      client.off('monsterAttackResult');
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

  const handleDrawFromMain = () => {
    socket?.emit('drawFromMain');
  };

  const handleMulligan = () => {
    socket?.emit('mulligan');
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
    if (!gameState || gameState.status !== 'in_progress') return;
    socket?.emit('playHero', instanceId);
    setSelectedHeroId(null);
    setSelectedHeroLocation(null);
  };

  const confirmPlayHero = () => {
    setPendingHeroPlayId(null);
    setPendingHeroAbilityActivationId(null);
    setPlayHeroPromptOpen(false);
  };

  const handleActivateHeroAbility = (heroInstanceId: string) => {
    if (!socket) return;
    socket.emit('activateHeroAbility', heroInstanceId);
    setPendingHeroAbilityActivationId(null);
  };

  const handleRespondToAbilityPrompt = (optionId: string) => {
    if (!socket || !abilityPrompt) return;
    socket.emit('respondToAbilityPrompt', abilityPrompt.promptId, optionId);
    setAbilityPrompt(null);
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
  };

  const handleCancelPlayItem = () => {
    setItemPlayPromptOpen(false);
    setPendingItemPlayId(null);
  };

  const handlePlayMagic = (instanceId: string) => {
    if (!gameState || gameState.status !== 'in_progress') return;
    socket?.emit('playMagic', instanceId);
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

  const handleAttackMonster = (monsterInstanceId: string) => {
    socket?.emit('attackMonster', monsterInstanceId);
  };

  const handleUsePartyLeaderAbility = () => {
    socket?.emit('usePartyLeaderAbility');
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
  const isMyTurn = gameState?.status === 'in_progress' && gameState.activePlayerId === myId;

  const getChallengeCardBonus = (card: CardInstance): number => {
    if (!gameState) return 0;
    const template = gameState.cardTemplates[card.templateId];
    const effects = template?.onEvent?.effects;
    if (!effects) return 0;
    const modifyRoll = effects.find(e => e.action === 'MODIFY_ROLL');
    return modifyRoll?.amount ?? 0;
  };

  const getEligibleChallengeCards = (): CardInstance[] => {
    if (!gameState || !myPlayer) return [];
    return myPlayer.zones.hand.filter(card => {
      if (card.cardType !== 'challenge') return false;
      const template = gameState.cardTemplates[card.templateId];
      const req = template?.onEvent?.requirement;
      if (!req) return true;
      if (req.cardType === 'hero' && req.class && req.eligibility === 'self') {
        return myPlayer.zones.party.some(pc => {
          const pcTemplate = gameState.cardTemplates[pc.templateId];
          const baseClass = pcTemplate?.class;
          if (!pc.equippedItem) return baseClass === req.class;
          const itemInst = myPlayer.zones.party.find(c => c.instanceId === pc.equippedItem);
          if (!itemInst) return baseClass === req.class;
          const itemTemplate = gameState.cardTemplates[itemInst.templateId];
          const passives = itemTemplate?.passiveModifiers;
          const classOverride = passives?.find(p => p.stat === 'class' && p.override)?.override;
          return (classOverride ?? baseClass) === req.class;
        });
      }
      return true;
    });
  };

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
          {challengeResult && (
            <div style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '8px', backgroundColor: challengeResult.challengerWon ? '#fff3cd' : '#d4edda', border: `1px solid ${challengeResult.challengerWon ? '#ffc107' : '#28a745'}`, color: '#333' }}>
              <strong>Challenge!</strong>{' '}
              {challengeResult.challengerName} rolled {challengeResult.challengerRoll}
              {challengeResult.challengerBonus > 0 ? ` +${challengeResult.challengerBonus} = ${challengeResult.challengerTotalRoll}` : ''}{' '}
              vs {challengeResult.challengedName} rolled {challengeResult.challengedRoll}.{' '}
              {challengeResult.challengerWon
                ? `${challengeResult.challengerName} wins — ${challengeResult.cardName} is discarded!`
                : `${challengeResult.challengedName} wins — ${challengeResult.cardName} is played!`}
            </div>
          )}
          {monsterAttackResult && (
            <div style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '8px', backgroundColor: monsterAttackResult.slew ? '#d4edda' : '#fff3cd', border: `1px solid ${monsterAttackResult.slew ? '#28a745' : '#ffc107'}`, color: '#333' }}>
              <strong>{monsterAttackResult.slew ? 'Monster Slain!' : 'Attack Result'}</strong>{' '}
              {monsterAttackResult.attackerName} rolled <strong>{monsterAttackResult.roll}</strong> against{' '}
              <strong>{monsterAttackResult.monsterName}</strong> (needed {monsterAttackResult.requiredRoll}).{' '}
              {monsterAttackResult.effectText}
            </div>
          )}
          {gameState?.pendingChallenge?.pendingPlayerId === myId && (
            <div style={{ padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: '8px', backgroundColor: '#fff3cd', border: '1px solid #ffc107', color: '#333' }}>
              Your <strong>{gameState.pendingChallenge!.pendingCardName}</strong> play is pending — waiting for opponents to respond...
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '1rem', minHeight: 'calc(100vh - 260px)' }}>
          <main className="mainContent">
            {gameState?.status === 'finished' && (() => {
              const winnerId = gameState.winnerId;
              const winner = winnerId ? gameState.players[winnerId] : undefined;
              return (
                <div style={{ padding: '2rem', borderRadius: '12px', backgroundColor: '#d4edda', border: '2px solid #28a745', marginBottom: '1.5rem', textAlign: 'center' }}>
                  <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>Game Over!</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                    {winner ? `${winner.username ?? winnerId} wins!` : 'Game over!'}
                  </div>
                  <div style={{ marginTop: '0.5rem', color: '#555' }}>
                    {winner && `${winner.slainMonsters.length} monster${winner.slainMonsters.length !== 1 ? 's' : ''} slain.`}
                  </div>
                </div>
              );
            })()}

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
                  <PartyLeaderCard
                    gameState={gameState}
                    myId={myId}
                    isMyTurn={isMyTurn}
                    onUsePartyLeaderAbility={handleUsePartyLeaderAbility}
                  />

                  <PartyCard
                    gameState={gameState} 
                    myId={myId}
                    selectedHeroId={selectedHeroId}
                    setSelectedHeroId={setSelectedHeroId}
                    viewedItemId={viewedItemId}
                    setViewedItemId={setViewedItemId}
                    setSelectedHeroLocation={setSelectedHeroLocation}
                    setHeroRollResult={setHeroRollResult}
                    isMyTurn={isMyTurn}
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
                    handlePlayMagic={handlePlayMagic}
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
                    handleActivateHeroAbility={handleActivateHeroAbility}
                    pendingHeroAbilityActivationId={pendingHeroAbilityActivationId}
                    playHeroRollResult={playHeroRollResult}
                    isMyTurn={isMyTurn}
                  />
                </div>
                
                <EndTurnButton 
                  gameState={gameState}
                  myId={myId}
                  handleEndTurn={handleEndTurn}
                />
                
                <MainDeckCard
                  gameState={gameState}
                  myId={myId}
                  showDrawPrompt={showDrawPrompt}
                  actionMessage={actionMessage}
                  justDrew={justDrew}
                  setActionMessage={setActionMessage}
                  setShowDrawPrompt={setShowDrawPrompt}
                  handleDrawFromMain={handleDrawFromMain}
                  handleMulligan={handleMulligan}
                />

                <DiscardPileCard
                  gameState={gameState}
                  showDiscardPile={showDiscardPile}
                  setShowDiscardPile={setShowDiscardPile}
                />
              </>
            )}
          </main>

          <aside className="sidebar">
            {abilityPrompt && (
              <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px', width: 'min(90vw, 480px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
                  <h3 style={{ marginTop: 0 }}>Ability Prompt</h3>
                  <p>{abilityPrompt.message}</p>
                  <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
                    {abilityPrompt.options.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => handleRespondToAbilityPrompt(option.id)}
                        style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: 'none', backgroundColor: '#007bff', color: 'white', cursor: 'pointer' }}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            {itemPlayPromptOpen && pendingItemPlayId && gameState && (() => {
              const itemCard = gameState.players[myId]?.zones.hand.find(c => c.instanceId === pendingItemPlayId);
              const itemName = itemCard ? (gameState.cardTemplates[itemCard.templateId]?.name ?? 'Item') : 'Item';
              const eligibleHeroes = gameState.players[myId]?.zones.party.filter(c => c.cardType === 'hero' && !c.equippedItem) ?? [];
              return (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                  <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px', width: 'min(90vw, 480px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
                    <h3 style={{ marginTop: 0 }}>Equip {itemName}</h3>
                    <p style={{ color: '#666', fontSize: '0.9rem' }}>Choose a hero to equip this item on:</p>
                    {eligibleHeroes.length === 0 ? (
                      <p style={{ color: '#c00' }}>No heroes available (all heroes already have an item).</p>
                    ) : (
                      <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
                        {eligibleHeroes.map(hero => (
                          <button
                            key={hero.instanceId}
                            type="button"
                            onClick={() => handleConfirmPlayItem(hero.instanceId)}
                            style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: 'none', backgroundColor: '#007bff', color: 'white', cursor: 'pointer' }}
                          >
                            {gameState.cardTemplates[hero.templateId]?.name ?? hero.templateId}
                          </button>
                        ))}
                      </div>
                    )}
                    <button type="button" onClick={handleCancelPlayItem} style={{ marginTop: '1rem', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid #ccc', backgroundColor: 'white', cursor: 'pointer' }}>
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })()}
            {cursedItemPlayPromptOpen && pendingCursedItemPlayId && gameState && (() => {
              const opponents = Object.entries(gameState.players).filter(([id]) => id !== myId);
              const targetOpponent = selectedTargetOpponentId ? gameState.players[selectedTargetOpponentId] : null;
              const eligibleHeroes = targetOpponent?.zones.party.filter(c => c.cardType === 'hero' && !c.equippedItem) ?? [];
              return (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                  <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px', width: 'min(90vw, 480px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
                    <h3 style={{ marginTop: 0 }}>Play Cursed Item</h3>
                    {!selectedTargetOpponentId ? (
                      <>
                        <p style={{ color: '#666', fontSize: '0.9rem' }}>Choose an opponent to curse:</p>
                        <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
                          {opponents.map(([id, p]) => (
                            <button
                              key={id}
                              type="button"
                              onClick={() => setSelectedTargetOpponentId(id)}
                              style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: 'none', backgroundColor: '#dc3545', color: 'white', cursor: 'pointer' }}
                            >
                              {p.username ?? id}
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <>
                        <p style={{ color: '#666', fontSize: '0.9rem' }}>Choose a hero from {targetOpponent?.username ?? selectedTargetOpponentId} to curse:</p>
                        {eligibleHeroes.length === 0 ? (
                          <p style={{ color: '#c00' }}>No heroes available (all heroes already have an item).</p>
                        ) : (
                          <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
                            {eligibleHeroes.map(hero => (
                              <button
                                key={hero.instanceId}
                                type="button"
                                onClick={() => handleConfirmCursedItemPlay(hero.instanceId)}
                                style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: 'none', backgroundColor: '#dc3545', color: 'white', cursor: 'pointer' }}
                              >
                                {gameState.cardTemplates[hero.templateId]?.name ?? hero.templateId}
                              </button>
                            ))}
                          </div>
                        )}
                      </>
                    )}
                    <button type="button" onClick={handleCancelCursedItemPlay} style={{ marginTop: '1rem', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid #ccc', backgroundColor: 'white', cursor: 'pointer' }}>
                      {selectedTargetOpponentId ? 'Back' : 'Cancel'}
                    </button>
                  </div>
                </div>
              );
            })()}
            {gameState?.pendingChallenge && gameState.pendingChallenge.eligibleChallengerIds.includes(myId) && (() => {
              const pending = gameState.pendingChallenge!;
              const challengingPlayer = gameState.players[pending.pendingPlayerId];
              const eligibleCards = getEligibleChallengeCards();
              return (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                  <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px', width: 'min(90vw, 480px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
                    <h3 style={{ marginTop: 0 }}>Challenge?</h3>
                    <p style={{ color: '#555', fontSize: '0.9rem' }}>
                      <strong>{challengingPlayer?.username ?? 'A player'}</strong> is playing{' '}
                      <strong>{pending.pendingCardName}</strong>. Do you want to challenge it?
                    </p>
                    {eligibleCards.length > 0 ? (
                      <div style={{ display: 'grid', gap: '0.75rem', marginTop: '1rem' }}>
                        {eligibleCards.map(card => {
                          const cardTemplate = gameState.cardTemplates[card.templateId];
                          const bonus = getChallengeCardBonus(card);
                          return (
                            <button
                              key={card.instanceId}
                              type="button"
                              onClick={() => socket?.emit('playChallenge', card.instanceId)}
                              style={{ padding: '0.75rem 1rem', borderRadius: '8px', border: 'none', backgroundColor: '#e74c3c', color: 'white', cursor: 'pointer', textAlign: 'left' }}
                            >
                              <div style={{ fontWeight: 'bold' }}>{cardTemplate?.name ?? card.templateId}</div>
                              {bonus > 0 && <div style={{ fontSize: '0.8rem', marginTop: '0.25rem' }}>+{bonus} to your roll</div>}
                              <div style={{ fontSize: '0.75rem', marginTop: '0.25rem', opacity: 0.9 }}>{cardTemplate?.abilityText as string ?? ''}</div>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p style={{ color: '#c00' }}>No eligible challenge cards available.</p>
                    )}
                    <button
                      type="button"
                      onClick={() => socket?.emit('passChallenge')}
                      style={{ marginTop: '1rem', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid #ccc', backgroundColor: 'white', cursor: 'pointer', width: '100%' }}
                    >
                      Pass (don't challenge)
                    </button>
                  </div>
                </div>
              );
            })()}
            {gameState?.modifierPhase && (() => {
              const mPhase = gameState.modifierPhase!;
              const isMyModifierTurn = mPhase.activePlayerId === myId;
              const isFailing = mPhase.currentTotal < mPhase.requiredRoll;
              const rollingPlayer = gameState.players[mPhase.rollingPlayerId];
              const myModifiers = myPlayer?.zones.hand.filter(c => c.cardType === 'modifier') ?? [];
              return (
                <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.55)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
                  <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px', width: 'min(90vw, 520px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)', maxHeight: '90vh', overflowY: 'auto' }}>
                    <h3 style={{ marginTop: 0 }}>Modifier Phase</h3>
                    <p style={{ marginBottom: '0.25rem' }}>
                      <strong>{rollingPlayer?.username ?? 'A player'}</strong> rolled{' '}
                      <strong>{mPhase.die1} + {mPhase.die2}</strong>
                      {mPhase.persistentBonus ? ` + ${mPhase.persistentBonus}` : ''}
                      {mPhase.accumulatedModifier ? (mPhase.accumulatedModifier >= 0 ? ` + ${mPhase.accumulatedModifier}` : ` - ${Math.abs(mPhase.accumulatedModifier)}`) : ''}{' '}
                      = <strong>{mPhase.currentTotal}</strong> / need <strong>{mPhase.requiredRoll}</strong>
                    </p>
                    <p style={{ marginTop: 0, marginBottom: '0.75rem' }}>
                      Currently{' '}
                      <strong style={{ color: isFailing ? '#c00' : '#28a745' }}>
                        {isFailing ? 'failing' : 'succeeding'}
                      </strong>
                    </p>

                    {mPhase.modifiersPlayed.length > 0 && (
                      <div style={{ marginBottom: '1rem', padding: '0.5rem 0.75rem', backgroundColor: '#f8f9fa', borderRadius: '6px', fontSize: '0.8rem' }}>
                        <div style={{ fontWeight: 'bold', marginBottom: '0.25rem' }}>Modifiers played:</div>
                        {mPhase.modifiersPlayed.map((m, i) => (
                          <div key={i}>{m.playerName}: {m.cardName} ({m.choiceLabel})</div>
                        ))}
                      </div>
                    )}

                    {isMyModifierTurn ? (
                      <>
                        <p style={{ color: '#555', marginBottom: '0.75rem', fontSize: '0.9rem' }}>
                          {mPhase.phase === 'roller_turn'
                            ? 'Your roll is failing. Play a modifier card to try to succeed, or pass.'
                            : 'Play a modifier card to affect the roll, then pass when done.'}
                        </p>
                        {myModifiers.length === 0 && (
                          <p style={{ color: '#888', fontSize: '0.85rem' }}>No modifier cards in hand.</p>
                        )}
                        {myModifiers.map(card => {
                          const tmpl = gameState.cardTemplates[card.templateId];
                          const choices = tmpl?.choices;
                          const effects = tmpl?.effects;
                          return (
                            <div key={card.instanceId} style={{ marginBottom: '0.75rem', padding: '0.6rem 0.75rem', border: '1px solid #dee2e6', borderRadius: '8px' }}>
                              <div style={{ fontWeight: 'bold', fontSize: '0.85rem' }}>{tmpl?.name ?? 'Modifier'}</div>
                              <div style={{ fontSize: '0.72rem', color: '#555', margin: '0.2rem 0 0.5rem' }}>{tmpl?.abilityText ?? ''}</div>
                              <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                                {choices ? choices.map((choice, i) => {
                                  const upgrade = choice.conditionalUpgrades?.find(
                                    u => u.condition?.rollContext === mPhase.rollContext
                                  );
                                  const effectiveLabel: string = upgrade?.label ?? choice.label ?? '?';
                                  const effectiveAmount: number = upgrade?.effects?.[0]?.amount ?? choice.effects?.[0]?.amount ?? 0;
                                  return (
                                    <button
                                      key={i}
                                      type="button"
                                      onClick={() => socket?.emit('playModifier', card.instanceId, i)}
                                      style={{ padding: '0.4rem 0.8rem', borderRadius: '6px', border: 'none', backgroundColor: effectiveAmount >= 0 ? '#28a745' : '#dc3545', color: 'white', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem' }}
                                    >
                                      {effectiveLabel}
                                    </button>
                                  );
                                }) : (
                                  <button
                                    type="button"
                                    onClick={() => socket?.emit('playModifier', card.instanceId, 0)}
                                    style={{ padding: '0.4rem 0.8rem', borderRadius: '6px', border: 'none', backgroundColor: (effects?.[0]?.amount ?? 0) >= 0 ? '#28a745' : '#dc3545', color: 'white', cursor: 'pointer', fontWeight: 'bold', fontSize: '0.85rem' }}
                                  >
                                    {(effects?.[0]?.amount ?? 0) >= 0 ? '+' : ''}{effects?.[0]?.amount ?? 0}
                                  </button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                        <button
                          type="button"
                          onClick={() => socket?.emit('passModifier')}
                          style={{ marginTop: '0.25rem', padding: '0.5rem 1rem', borderRadius: '8px', border: '1px solid #ccc', backgroundColor: 'white', cursor: 'pointer', width: '100%', fontWeight: 'bold' }}
                        >
                          {mPhase.phase === 'roller_turn' ? 'Pass (accept current result)' : 'Pass to next player'}
                        </button>
                      </>
                    ) : (
                      <p style={{ color: '#666', fontSize: '0.9rem' }}>
                        Waiting for{' '}
                        <strong>{gameState.players[mPhase.activePlayerId]?.username ?? 'a player'}</strong>{' '}
                        to play or pass…
                      </p>
                    )}
                  </div>
                </div>
              );
            })()}
            {gameState?.status === 'in_progress' && (
              <>
                <ActiveMonstersSidebarCard
                gameState={gameState}
                myId={myId}
                isMyTurn={isMyTurn}
                selectedMonsterId={selectedMonsterId}
                setSelectedMonsterId={setSelectedMonsterId}
                onAttackMonster={handleAttackMonster}
              />

                <OpponentInformationCard
                  gameState={gameState}
                  myId={myId}
                  selectedOpponentPartyId={selectedOpponentPartyId}
                  viewedItemId={viewedItemId}
                  setSelectedOpponentPartyId={setSelectedOpponentPartyId}
                  setViewedItemId={setViewedItemId}
                />
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
