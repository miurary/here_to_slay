import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import type { AbilityPrompt, ChallengeResolvedData, ClientToServerEvents, ServerToClientEvents, GameState, CardInstance, PlayerState, MonsterAttackResultData } from '../../shared/types';
import { setActiveSocket } from './utils/socketRef';
import './App.css';

import FirstRollCard from './components/game/FirstRollCard';
import PartyLeaderSelectionCard from './components/game/PartyLeaderSelectionCard';
import PartyLeaderReviewCard from './components/game/PartyLeaderReviewCard';
import RollCompleteCard from './components/game/RollCompleteCard';
import ChatLogPanel from './components/game/ChatLogPanel';
import GameTable from './components/game/table/GameTable';
import { getPlayerId } from './utils/playerId';

const MAX_PLAYERS = 6;
// Fixed lobby avatar palette, assigned by join order.
const AVATAR_COLORS = ['#2563eb', '#dc2626', '#059669', '#d97706', '#7c3aed', '#0891b2'];

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
  const MIN_ROLL_ANIMATION_MS = 2000;
  // How long the dice take to settle onto their faces once the tumble stops.
  const ROLL_SETTLE_MS = 900;
  // Keeps FirstRollCard mounted through my tumble + settle, even after the
  // server has already moved the room to roll_complete (the last roller would
  // otherwise never see their animation).
  const [rollAnimActive, setRollAnimActive] = useState(false);
  const [myRoll, setMyRoll] = useState<number | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [leaderModalOpen, setLeaderModalOpen] = useState(false);
  const [selectedHeroId, setSelectedHeroId] = useState<string | null>(null);
  const [selectedHeroLocation, setSelectedHeroLocation] = useState<'hand' | 'party' | null>(null);
  const [heroRollResult, setHeroRollResult] = useState<string | null>(null);
  const [playHeroPromptOpen, setPlayHeroPromptOpen] = useState(false);
  const [pendingHeroPlayId, setPendingHeroPlayId] = useState<string | null>(null);
  const [pendingHeroAbilityActivationId, setPendingHeroAbilityActivationId] = useState<string | null>(null);
  // Prompts are queued so that multiple prompts triggered in the same tick
  // (e.g. drawing two Modifiers with Rex Major) are each resolved in turn rather
  // than overwriting one another. The head of the queue is the active prompt.
  const [abilityPromptQueue, setAbilityPromptQueue] = useState<AbilityPrompt[]>([]);
  const abilityPrompt = abilityPromptQueue[0] ?? null;
  const [multiSelected, setMultiSelected] = useState<string[]>([]);
  const [playHeroRollResult, setPlayHeroRollResult] = useState<string | null>(null);
  const [isHeroRolling, setIsHeroRolling] = useState(false);
  const [rolledDice, setRolledDice] = useState<{ die1: number; die2: number } | null>(null);
  const rollAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(rollAnimationTimer);
  const pendingHeroPlayIdRef = useRef<string | null>(pendingHeroPlayId);
  const selectedHeroIdRef = useRef<string | null>(selectedHeroId);
  const selectedHeroLocationRef = useRef<'hand' | 'party' | null>(selectedHeroLocation);
  const heroRollAnimationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(heroRollAnimationTimer);
  const isHeroRollingRef = useRef<boolean>(isHeroRolling);
  const playHeroPromptOpenRef = useRef<boolean>(playHeroPromptOpen);
  const [itemPlayPromptOpen, setItemPlayPromptOpen] = useState(false);
  const [pendingItemPlayId, setPendingItemPlayId] = useState<string | null>(null);
  const [cursedItemPlayPromptOpen, setCursedItemPlayPromptOpen] = useState(false);
  const [pendingCursedItemPlayId, setPendingCursedItemPlayId] = useState<string | null>(null);
  const [selectedTargetOpponentId, setSelectedTargetOpponentId] = useState<string | null>(null);
  const [challengeResult, setChallengeResult] = useState<ChallengeResolvedData | null>(null);
  const [monsterAttackResult, setMonsterAttackResult] = useState<MonsterAttackResultData | null>(null);
  const [status, setStatus] = useState<string>(!roomCode ? 'Missing room code.' : 'Connecting...');
  const [players, setPlayers] = useState<PlayerState[]>([]);
  const [socket, setSocket] = useState<Socket<ServerToClientEvents, ClientToServerEvents> | null>(null);
  const [inviteCopied, setInviteCopied] = useState(false);

  useEffect(() => {
    rollAnimationTimerRef.current = rollAnimationTimer;
    pendingHeroPlayIdRef.current = pendingHeroPlayId;
    selectedHeroIdRef.current = selectedHeroId;
    selectedHeroLocationRef.current = selectedHeroLocation;
    heroRollAnimationTimerRef.current = heroRollAnimationTimer;
    isHeroRollingRef.current = isHeroRolling;
    playHeroPromptOpenRef.current = playHeroPromptOpen;
  }, [rollAnimationTimer, pendingHeroPlayId, selectedHeroId, selectedHeroLocation, heroRollAnimationTimer, isHeroRolling, playHeroPromptOpen]);

  useEffect(() => {
    if (!roomCode) return;

    // Stable identity across reconnects — the server keys our seat by this,
    // not by the socket id.
    const playerId = getPlayerId();

    const client = io(`${import.meta.env.VITE_API_URL}`, {
      withCredentials: true,
      auth: {
        roomCode,
        username: name || undefined,
        playerId,
      },
    });

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSocket(client);
    // Expose the socket to app-level UI (the bug-report button).
    setActiveSocket(client);

    client.on('connect', () => {
      setMyId(playerId);
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

      setMyRoll(state.diceRolls[playerId] ?? null);

      // Via the ref: the closure's rollAnimationTimer is stale (this handler is
      // registered once per room), so reading the state var would always see null.
      if (!rollAnimationTimerRef.current) {
        setIsRolling(false);
      }

      // If a hero was just played via ability and is now in the party, show roll prompt
      const pendingId = pendingHeroPlayIdRef.current;
      if (pendingId) {
        const myPlayer = state.players[playerId];
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
      setRolledDice({ die1: result.die1, die2: result.die2 });
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
      setAbilityPromptQueue((q) => [...q, prompt]);
      setActionMessage(null);
    });
    client.on('abilityResolution', (data) => {
      setActionMessage(data.message);
      // Queued prompts are removed only when answered, so a resolution arriving in
      // the same tick (e.g. alongside a slain-monster passive prompt) leaves the
      // queue intact.
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

    client.on('roomFull', (msg: string) => {
      client.disconnect();
      navigate('/', { state: { error: msg } });
    });

    client.on('roomNotFound', (msg: string) => {
      client.disconnect();
      navigate('/', { state: { error: msg } });
    });

    client.on('connect_error', (error) => {
      setStatus(`Unable to join room: ${error.message}`);
    });

    client.on('disconnect', () => {
      setStatus('Connection lost — reconnecting…');
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
      client.off('roomFull');
      client.off('roomNotFound');
      client.off('connect_error');
      setActiveSocket(null);
      client.disconnect();
    };
  }, [roomCode]);

  useEffect(() => {
    if (name.trim()) {
      localStorage.setItem('username', name.trim());
      socket?.emit('setUsername', name.trim());
    }
  }, [name, socket]);

  // Countdown to the server's scheduled auto-advance (roll_complete /
  // party_leader_review). The server broadcasts the target timestamp; we just
  // re-render against the local clock while one is pending.
  const autoAdvanceAt = gameState?.autoAdvanceAt ?? null;
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!autoAdvanceAt) return;
    const tick = () => setNowTick(Date.now());
    tick();
    const id = setInterval(tick, 250);
    return () => clearInterval(id);
  }, [autoAdvanceAt]);
  const autoAdvanceSeconds = autoAdvanceAt ? Math.max(0, Math.ceil((autoAdvanceAt - nowTick) / 1000)) : null;

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

  const handleToggleReady = () => {
    socket?.emit('toggleReady');
  };

  const handleCopyInvite = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      setActionMessage('Could not copy the invite link — copy the page URL instead.');
      setTimeout(() => setActionMessage(null), 3000);
    }
  };

  const handleRoll = () => {
    if (rollAnimationTimer) {
      clearTimeout(rollAnimationTimer);
    }

    setIsRolling(true);
    setRollAnimActive(true);
    const timer = setTimeout(() => {
      setIsRolling(false);
      setRollAnimationTimer(null);
      // Hold the roll card while the dice settle onto their faces before
      // revealing the results screen.
      setTimeout(() => setRollAnimActive(false), ROLL_SETTLE_MS);
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

  // Discard your whole hand and redraw (server validates: costs 3 AP, needs a
  // deck of at least 5).
  const handleMulligan = () => {
    socket?.emit('mulligan');
  };

  const handleChoosePartyLeader = (instanceId: string) => {
    if (gameState?.status !== 'party_leader_selection') {
      return;
    }
    socket?.emit('choosePartyLeader', instanceId);
  };

  const handleEndTurn = () => {
    socket?.emit('endTurn');
  };

  const handleSendChat = (message: string) => {
    socket?.emit('sendChat', message);
  };

  // Select a party hero to roll its ability (drives the felt roll strip).
  const handleSelectPartyHero = (heroInstanceId: string) => {
    setSelectedHeroId(heroInstanceId);
    setSelectedHeroLocation('party');
    setHeroRollResult(null);
  };

  const handlePlayModifier = (modifierInstanceId: string, choiceIndex: number) => {
    socket?.emit('playModifier', modifierInstanceId, choiceIndex);
  };
  const handlePassModifier = () => {
    socket?.emit('passModifier');
  };
  const handlePlayChallenge = (cardInstanceId: string) => {
    socket?.emit('playChallenge', cardInstanceId);
  };
  const handlePassChallenge = () => {
    socket?.emit('passChallenge');
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
    setSelectedHeroId(null);
    setSelectedHeroLocation(null);
  };

  // Fully dismiss the standalone hero-ability modal (post-play roll prompt or a
  // party hero's ability) and clear the related selection state.
  const closeHeroAbilityModal = () => {
    setPlayHeroPromptOpen(false);
    setPendingHeroPlayId(null);
    setPendingHeroAbilityActivationId(null);
    setPlayHeroRollResult(null);
    setHeroRollResult(null);
    setSelectedHeroId(null);
    setSelectedHeroLocation(null);
  };

  const handleActivateHeroAbility = (heroInstanceId: string) => {
    if (!socket) return;
    socket.emit('activateHeroAbility', heroInstanceId);
    setPendingHeroAbilityActivationId(null);
  };

  const handleRespondToAbilityPrompt = (optionId: string) => {
    if (!socket || !abilityPrompt) return;
    socket.emit('respondToAbilityPrompt', abilityPrompt.promptId, optionId);
    setAbilityPromptQueue((q) => q.slice(1));
    setMultiSelected([]);
  };

  const toggleMultiSelect = (optionId: string) => {
    const max = abilityPrompt?.maxSelections ?? Infinity;
    setMultiSelected((prev) => {
      if (prev.includes(optionId)) return prev.filter((id) => id !== optionId);
      if (prev.length >= max) return prev; // at the cap — ignore further picks
      return [...prev, optionId];
    });
  };

  const handleRespondToAbilityPromptMulti = () => {
    if (!socket || !abilityPrompt) return;
    socket.emit('respondToAbilityPromptMulti', abilityPrompt.promptId, multiSelected);
    setAbilityPromptQueue((q) => q.slice(1));
    setMultiSelected([]);
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
    setRolledDice(null);
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

  // Play a selected hand card by type. For a hero this triggers heroPlayAccepted,
  // which opens the felt roll strip; items/cursed items open a target picker.
  const playHandCard = (card: CardInstance) => {
    if (!gameState || gameState.status !== 'in_progress') return;
    if (card.cardType === 'hero') {
      handlePlayHero(card.instanceId);
    } else if (card.cardType === 'magic') {
      handlePlayMagic(card.instanceId);
    } else if (card.cardType === 'item') {
      const tmpl = gameState.cardTemplates[card.templateId];
      const isCursed = (tmpl?.subtype as string | undefined)?.toLowerCase() === 'cursed';
      if (isCursed) {
        handleInitiateCursedItemPlay(card.instanceId);
      } else {
        setPendingItemPlayId(card.instanceId);
        setItemPlayPromptOpen(true);
      }
    }
  };

  const handleInitiateCursedItemPlay = (instanceId: string) => {
    if (!gameState || gameState.status !== 'in_progress') return;
    setPendingCursedItemPlayId(instanceId);
    setSelectedTargetOpponentId(null);
    setCursedItemPlayPromptOpen(true);
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
    setRolledDice(null);
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
  const isMyTurn = gameState?.status === 'in_progress' && gameState.activePlayerId === myId;

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

  const isInGame = !!(gameState && gameState.status === 'in_progress' && gameState.players[myId]);

  // ── In-progress game → the redesigned poker-table screen (GameTable). ─────
  if (isInGame && gameState) {
    return (
      <GameTable
        gameState={gameState}
        myId={myId}
        isMyTurn={isMyTurn}
        selectedHeroId={selectedHeroId}
        selectedHeroLocation={selectedHeroLocation}
        playHeroPromptOpen={playHeroPromptOpen}
        isHeroRolling={isHeroRolling}
        rolledDice={rolledDice}
        playHeroRollResult={playHeroRollResult}
        heroRollResult={heroRollResult}
        pendingHeroAbilityActivationId={pendingHeroAbilityActivationId}
        onSelectPartyHero={handleSelectPartyHero}
        onRollPlayHero={handlePlayHeroRoll}
        onSkipPlayHero={handleSkipPlayHeroRoll}
        onRollPartyHero={handleRollHeroAbility}
        onActivateHeroAbility={handleActivateHeroAbility}
        onCloseHeroRoll={closeHeroAbilityModal}
        onPlayHandCard={playHandCard}
        itemPickerOpen={itemPlayPromptOpen}
        pendingItemPlayId={pendingItemPlayId}
        onConfirmItem={handleConfirmPlayItem}
        onCancelItem={handleCancelPlayItem}
        cursedPickerOpen={cursedItemPlayPromptOpen}
        selectedTargetOpponentId={selectedTargetOpponentId}
        onSelectCurseOpponent={setSelectedTargetOpponentId}
        onConfirmCursedItem={handleConfirmCursedItemPlay}
        onCancelCursedItem={handleCancelCursedItemPlay}
        onPlayModifier={handlePlayModifier}
        onPassModifier={handlePassModifier}
        eligibleChallengeCards={getEligibleChallengeCards()}
        challengeResult={challengeResult}
        onClearChallengeResult={() => setChallengeResult(null)}
        onPlayChallenge={handlePlayChallenge}
        onPassChallenge={handlePassChallenge}
        onAttackMonster={handleAttackMonster}
        monsterAttackResult={monsterAttackResult}
        onClearMonsterResult={() => setMonsterAttackResult(null)}
        onDrawFromMain={handleDrawFromMain}
        onMulligan={handleMulligan}
        onEndTurn={handleEndTurn}
        leaderOpen={leaderModalOpen}
        onOpenLeader={() => { setActionMessage(null); setLeaderModalOpen(true); }}
        onCloseLeader={() => { setActionMessage(null); setLeaderModalOpen(false); }}
        onUseLeaderAbility={handleUsePartyLeaderAbility}
        actionMessage={actionMessage}
        abilityPrompt={abilityPrompt}
        abilityPromptQueueLength={abilityPromptQueue.length}
        multiSelected={multiSelected}
        onToggleMulti={toggleMultiSelect}
        onRespondPrompt={handleRespondToAbilityPrompt}
        onRespondPromptMulti={handleRespondToAbilityPromptMulti}
        onSendChat={handleSendChat}
        onLeave={() => navigate('/')}
      />
    );
  }

  // ── Pre-game lobby / roll-off / party-leader flows (unchanged layout). ────
  return (
    <div className="gameShell">
      <div className="gameGrid">
        {/* Row 1 — header: room code + username + back */}
        <header className="gameHeader">
          <div className="gameHeaderLeft">
            <h1>Room {roomCode}</h1>
            <p>Status: <strong>{status}</strong></p>
            <button
              type="button"
              onClick={handleCopyInvite}
              className="buttonPrimary"
              style={{ padding: '6px 12px', fontSize: '0.8rem', alignSelf: 'flex-start', ...(inviteCopied ? { background: '#16a34a' } : {}) }}
            >
              {inviteCopied ? '✓ Link copied!' : '🔗 Copy invite link'}
            </button>
          </div>
          <form className="gameHeaderUsername" onSubmit={handleSubmit}>
            <input
              id="username"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Username"
              className="usernameInput"
            />
            <button type="submit" className="primaryButton">Save</button>
          </form>
          <button type="button" onClick={() => navigate('/')} className="primaryButton gameHeaderBack">
            Back to Home
          </button>
        </header>

        {/* Row 2 — centered status / info panel */}
        <div className="gameStatusRow">
          {actionMessage && !leaderModalOpen && <div className="bannerError">{actionMessage}</div>}
        </div>

        {/* Row 3 — pre-game board: players list · center flow · chat */}
        <div className="gameBoardPre">
          <div className="boardPreGrid">
            <aside className="boardPreLeft">
              <div className="panel" style={{ padding: '1rem' }}>
                <h3>Players ({players.length}/{MAX_PLAYERS})</h3>
                <div style={{ display: 'grid', gap: '0.5rem' }}>
                  {players.map((player, index) => {
                    const isLeader = player.id === gameState?.lobbyLeaderId;
                    const isMe = player.id === myId;
                    const isAway = player.connected === false;
                    const displayName = player.username || player.id;
                    return (
                      <div key={player.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.6rem', borderRadius: '8px', border: `1px solid ${isMe ? 'oklch(0.55 0.06 85)' : 'oklch(0.34 0.015 260)'}`, backgroundColor: isMe ? 'oklch(0.28 0.02 85)' : 'oklch(0.24 0.015 260)', opacity: isAway ? 0.55 : 1 }}>
                        <div style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length], color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                          {displayName.charAt(0).toUpperCase()}
                        </div>
                        <span style={{ fontWeight: isMe ? 700 : 400, color: '#e8e9ee', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {displayName}{isMe ? ' (you)' : ''}
                        </span>
                        {isLeader && <span title="Lobby leader">👑</span>}
                        {isAway ? (
                          <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '999px', color: '#ffd9a8', backgroundColor: 'oklch(0.32 0.07 70)' }}>
                            Reconnecting…
                          </span>
                        ) : gameState?.status === 'waiting' && !isLeader && (
                          <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '999px', color: player.ready ? 'oklch(0.85 0.11 150)' : '#9aa0ad', backgroundColor: player.ready ? 'oklch(0.32 0.07 150)' : 'oklch(0.3 0.015 260)' }}>
                            {player.ready ? '✓ Ready' : 'Not ready'}
                          </span>
                        )}
                      </div>
                    );
                  })}
                  {gameState?.status === 'waiting' && Array.from({ length: Math.max(0, MAX_PLAYERS - players.length) }).map((_, i) => (
                    <div key={`empty-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.6rem', borderRadius: '8px', border: '1px dashed oklch(0.38 0.015 260)', color: '#8f96a3' }}>
                      <div style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', border: '1px dashed oklch(0.38 0.015 260)', boxSizing: 'border-box' }} />
                      <span style={{ fontSize: '0.85rem', fontStyle: 'italic' }}>Waiting for a player…</span>
                    </div>
                  ))}
                </div>
              </div>
            </aside>

            <div className="boardPreInner">
            {gameState?.status === 'finished' && (() => {
              const winnerId = gameState.winnerId;
              const winner = winnerId ? gameState.players[winnerId] : undefined;
              return (
                <div style={{ padding: '2rem', borderRadius: '14px', backgroundColor: 'oklch(0.26 0.05 150)', border: '1px solid oklch(0.6 0.11 150)', textAlign: 'center' }}>
                  <div style={{ fontFamily: '"Alegreya", Georgia, serif', fontSize: '2rem', marginBottom: '0.5rem', color: 'oklch(0.85 0.11 150)' }}>Game Over!</div>
                  <div style={{ fontSize: '1.25rem', fontWeight: 'bold' }}>
                    {winner ? `${winner.username ?? winnerId} wins!` : 'Game over!'}
                  </div>
                  <div style={{ marginTop: '0.5rem', color: '#b9bfc9' }}>
                    {winner && `${winner.slainMonsters.length} monster${winner.slainMonsters.length !== 1 ? 's' : ''} slain.`}
                  </div>
                </div>
              );
            })()}

            {gameState?.status === 'waiting' && (() => {
              const leaderId = gameState.lobbyLeaderId;
              const leaderName = (leaderId ? gameState.players[leaderId]?.username : undefined) ?? 'the lobby leader';
              const amReady = !!players.find(p => p.id === myId)?.ready;
              // The leader starts the game, so only everyone else readies up.
              const everyoneReady = players.every(p => p.id === leaderId || p.ready);
              const canStart = players.length >= 2 && everyoneReady;
              const startHint = players.length < 2
                ? 'Need at least 2 players to start.'
                : everyoneReady ? null : 'Waiting for everyone to ready up…';
              return (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                  {leaderId === myId ? (
                    <>
                      <button type="button" onClick={handleStart} disabled={!canStart} className="buttonPrimary">
                        Start Game
                      </button>
                      {startHint && <span style={{ color: '#9aa0ad', fontSize: '0.9rem' }}>{startHint}</span>}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={handleToggleReady}
                        className="buttonPrimary"
                        style={amReady ? { background: '#16a34a', boxShadow: '0 14px 30px rgba(22, 163, 74, 0.18)' } : undefined}
                      >
                        {amReady ? '✓ Ready' : 'Ready up'}
                      </button>
                      <span style={{ color: '#9aa0ad', fontSize: '0.9rem' }}>
                        {amReady ? `Waiting for ${leaderName} to start the game…` : `Let ${leaderName} know you are ready to play.`}
                      </span>
                    </>
                  )}
                </div>
              );
            })()}

            {(gameState?.status === 'rolling' || (gameState?.status === 'roll_complete' && rollAnimActive)) && (
              <FirstRollCard gameState={gameState} myId={myId} handleRoll={handleRoll} isRolling={isRolling} myRoll={myRoll} />
            )}

            {gameState?.status === 'roll_complete' && !rollAnimActive && (
              <RollCompleteCard gameState={gameState} myId={myId} handleContinue={handleContinue} autoAdvanceSeconds={autoAdvanceSeconds} />
            )}

            {gameState?.status === 'party_leader_selection' && (
              <PartyLeaderSelectionCard gameState={gameState} myId={myId} handleChoosePartyLeader={handleChoosePartyLeader} />
            )}

            {gameState?.status === 'party_leader_review' && (
              <PartyLeaderReviewCard gameState={gameState} myId={myId} handleContinue={handleContinue} autoAdvanceSeconds={autoAdvanceSeconds} />
            )}

            </div>

            <aside className="boardPreRight">
              {gameState && (
                <ChatLogPanel gameState={gameState} entries={gameState.gameLog ?? []} myId={myId} onSend={handleSendChat} />
              )}
            </aside>
          </div>
        </div>
      </div>
    </div>
  );
}
