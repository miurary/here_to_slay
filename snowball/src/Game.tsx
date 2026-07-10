import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import type { AbilityPrompt, ChallengeResolvedData, ClientToServerEvents, ServerToClientEvents, GameState, CardInstance, PlayerState, MonsterAttackResultData } from '../../shared/types';
import { setActiveSocket } from './utils/socketRef';
import './App.css';

import FirstRollCard from './components/game/FirstRollCard';
import GameStatusCard from './components/game/GameStatusCard';
import CardArt from './components/CardArt';
import HandFan from './components/game/HandFan';
import HeroAbilityModal from './components/game/HeroAbilityModal';
import PartyCard from './components/game/PartyCard';
import PartyLeaderCard from './components/game/PartyLeaderCard';
import PartyLeaderSelectionCard from './components/game/PartyLeaderSelectionCard';
import PartyLeaderReviewCard from './components/game/PartyLeaderReviewCard';
import RollCompleteCard from './components/game/RollCompleteCard';
import EndTurnButton from './components/game/EndTurnButton';
import MainDeckCard from './components/game/MainDeckCard';
import DiscardPileCard from './components/game/DiscardPileCard';
import ActiveMonstersSidebarCard from './components/game/ActiveMonstersSidebarCard';
import ChatLogPanel from './components/game/ChatLogPanel';
import { getPlayerId } from './utils/playerId';
import OpponentInformationCard from './components/game/OpponentInformationCard';

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
  const [showDrawPrompt, setShowDrawPrompt] = useState(false);
  const [showDiscardPile, setShowDiscardPile] = useState(false);
  const [handDetailId, setHandDetailId] = useState<string | null>(null);
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

  const handleSendChat = (message: string) => {
    socket?.emit('sendChat', message);
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

  // Play whichever card is open in the hand card-detail modal, by type, then
  // close the modal. For a hero this triggers heroPlayAccepted, which opens the
  // ability-roll modal (HeroAbilityModal).
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
        setViewedItemId(null);
      }
    }
    setHandDetailId(null);
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
  const selectedHero = myPlayer?.zones.hand.find((card) => card.instanceId === selectedHeroId)
    ?? myPlayer?.zones.party.find((card) => card.instanceId === selectedHeroId);
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

  const isInGame = !!(gameState && gameState.status === 'in_progress' && gameState.players[myId]);

  // The hero-ability modal opens for a just-played hero (offer to roll) or for a
  // selected party hero — independently of whether the hand modal is open.
  const heroAbilityModalOpen = isInGame && !!selectedHero && (playHeroPromptOpen || selectedHeroLocation === 'party');
  const heroAbilityMode: 'play' | 'party' = playHeroPromptOpen ? 'play' : 'party';

  return (
    <div className="gameShell" onClick={() => setSelectedHeroId(null)}>

      {/* ── Fixed-overlay modals (render regardless of layout) ─────────────── */}
      {isInGame && handDetailId && gameState && (() => {
        const card = gameState.players[myId]?.zones.hand.find(c => c.instanceId === handDetailId);
        if (!card) return null;
        const template = gameState.cardTemplates[card.templateId];
        const reactive = card.cardType === 'challenge' || card.cardType === 'modifier';
        const ap = gameState.players[myId]?.actionPoints ?? 0;
        const canPlay = isMyTurn && !reactive && ap >= 1;
        const label = card.cardType === 'hero' ? 'Play Hero (-1 AP)'
          : card.cardType === 'item' ? 'Use Item (-1 AP)'
          : 'Play Magic (-1 AP)';
        return (
          <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }} onClick={() => setHandDetailId(null)}>
            <div style={{ backgroundColor: 'white', padding: '1.25rem', borderRadius: '16px', boxShadow: '0 8px 24px rgba(0,0,0,0.2)', maxHeight: '90vh', overflowY: 'auto' }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '0.5rem' }}>
                <button type="button" onClick={() => setHandDetailId(null)} className="primaryButton">Close</button>
              </div>
              <CardArt cardId={card.templateId} name={template?.name} style={{ width: 280, margin: '0 auto 1rem' }} />
              {reactive ? (
                <div style={{ textAlign: 'center', color: '#64748b', maxWidth: 280 }}>
                  Reactive card — plays automatically during the relevant phase.
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    disabled={!canPlay}
                    onClick={() => playHandCard(card)}
                    style={{ display: 'block', width: '100%', padding: '0.85rem 1rem', fontSize: '1rem', fontWeight: 700, color: 'white', backgroundColor: canPlay ? '#2563eb' : '#cbd5e1', border: 'none', borderRadius: '10px', cursor: canPlay ? 'pointer' : 'not-allowed' }}
                  >
                    {label}
                  </button>
                  {isMyTurn && ap < 1 && (
                    <div style={{ textAlign: 'center', color: '#c00', marginTop: '0.5rem', fontSize: '0.85rem' }}>Not enough AP.</div>
                  )}
                  {!isMyTurn && (
                    <div style={{ textAlign: 'center', color: '#888', marginTop: '0.5rem', fontSize: '0.85rem' }}>Only on your turn.</div>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })()}

      {heroAbilityModalOpen && selectedHero && gameState && (
        <HeroAbilityModal
          key={`${selectedHero.instanceId}-${heroAbilityMode}`}
          gameState={gameState}
          hero={selectedHero}
          mode={heroAbilityMode}
          isMyTurn={isMyTurn}
          isHeroRolling={isHeroRolling}
          rolledDie1={rolledDice?.die1}
          rolledDie2={rolledDice?.die2}
          modifierPhaseActive={!!gameState.modifierPhase && gameState.modifierPhase.rollingPlayerId === myId}
          playHeroRollResult={playHeroRollResult}
          handlePlayHeroRoll={handlePlayHeroRoll}
          handleSkipPlayHeroRoll={handleSkipPlayHeroRoll}
          heroRollResult={heroRollResult}
          handleRollHeroAbility={handleRollHeroAbility}
          pendingHeroAbilityActivationId={pendingHeroAbilityActivationId}
          handleActivateHeroAbility={handleActivateHeroAbility}
          onClose={closeHeroAbilityModal}
        />
      )}

      <div onClick={(e) => e.stopPropagation()}>
        <aside className="sidebarModals">
            {abilityPrompt && (
              <div style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', justifyContent: 'center', alignItems: 'center', zIndex: 1100 }}>
                <div style={{ backgroundColor: 'white', padding: '1.5rem', borderRadius: '12px', width: 'min(90vw, 480px)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}>
                  <h3 style={{ marginTop: 0 }}>
                    Ability Prompt
                    {abilityPromptQueue.length > 1 && (
                      <span style={{ fontSize: '0.75rem', fontWeight: 400, color: '#64748b', marginLeft: '0.5rem' }}>
                        ({abilityPromptQueue.length - 1} more pending)
                      </span>
                    )}
                  </h3>
                  <p>{abilityPrompt.message}</p>
                  {abilityPrompt.promptType === 'multiSelectCard' ? (
                    <>
                      <div style={{ display: 'grid', gap: '0.5rem', marginTop: '1rem', maxHeight: '50vh', overflowY: 'auto' }}>
                        {abilityPrompt.options.map((option) => {
                          const selected = multiSelected.includes(option.id);
                          return (
                            <button
                              key={option.id}
                              type="button"
                              onClick={() => toggleMultiSelect(option.id)}
                              style={{ padding: '0.6rem 1rem', borderRadius: '8px', border: selected ? '2px solid #1d4ed8' : '1px solid #cbd5e1', backgroundColor: selected ? '#dbeafe' : 'white', color: '#111827', cursor: 'pointer', textAlign: 'left', fontWeight: selected ? 700 : 400 }}
                            >
                              {selected ? '☑' : '☐'} {option.label}
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ marginTop: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '1rem' }}>
                        <span style={{ fontSize: '0.85rem', color: '#475569' }}>
                          {multiSelected.length} selected{abilityPrompt.maxSelections ? ` / ${abilityPrompt.maxSelections} max` : ''}
                        </span>
                        <button
                          type="button"
                          onClick={handleRespondToAbilityPromptMulti}
                          disabled={multiSelected.length < (abilityPrompt.minSelections ?? 0)}
                          style={{ padding: '0.6rem 1.25rem', borderRadius: '8px', border: 'none', backgroundColor: multiSelected.length < (abilityPrompt.minSelections ?? 0) ? '#cbd5e1' : '#2563eb', color: 'white', cursor: multiSelected.length < (abilityPrompt.minSelections ?? 0) ? 'not-allowed' : 'pointer', fontWeight: 700 }}
                        >
                          Confirm
                        </button>
                      </div>
                    </>
                  ) : (
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
                  )}
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
              const isFailing = mPhase.slayOnLow
                ? mPhase.currentTotal > mPhase.requiredRoll
                : mPhase.currentTotal < mPhase.requiredRoll;
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
                      = <strong>{mPhase.currentTotal}</strong> / need <strong>{mPhase.requiredRoll}{mPhase.slayOnLow ? ' or less' : ''}</strong>
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
        </aside>
      </div>

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
          {isInGame && gameState && (
            <div className="gameHeaderStatus">
              <GameStatusCard gameState={gameState} myId={myId} />
            </div>
          )}
          {isInGame && gameState && (
            <div className="gameHeaderOpponents">
              <OpponentInformationCard
                gameState={gameState}
                myId={myId}
                selectedOpponentPartyId={selectedOpponentPartyId}
                viewedItemId={viewedItemId}
                setSelectedOpponentPartyId={setSelectedOpponentPartyId}
                setViewedItemId={setViewedItemId}
              />
            </div>
          )}
          <button type="button" onClick={() => navigate('/')} className="primaryButton gameHeaderBack">
            Back to Home
          </button>
        </header>

        {/* Row 2 — centered status / info panel */}
        <div className="gameStatusRow">
          {actionMessage && !leaderModalOpen && <div className="bannerError">{actionMessage}</div>}
          {challengeResult && (
            <div style={{ padding: '0.5rem 1rem', borderRadius: '8px', backgroundColor: challengeResult.challengerWon ? '#fff3cd' : '#d4edda', border: `1px solid ${challengeResult.challengerWon ? '#ffc107' : '#28a745'}`, color: '#333' }}>
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
            <div style={{ padding: '0.5rem 1rem', borderRadius: '8px', backgroundColor: monsterAttackResult.slew ? '#d4edda' : '#fff3cd', border: `1px solid ${monsterAttackResult.slew ? '#28a745' : '#ffc107'}`, color: '#333' }}>
              <strong>{monsterAttackResult.slew ? 'Monster Slain!' : 'Attack Result'}</strong>{' '}
              {monsterAttackResult.attackerName} rolled <strong>{monsterAttackResult.roll}</strong> against{' '}
              <strong>{monsterAttackResult.monsterName}</strong> (needed {monsterAttackResult.requiredRoll}{monsterAttackResult.slayOnLow ? ' or less' : ''}).{' '}
              {monsterAttackResult.effectText}
            </div>
          )}
          {gameState?.pendingChallenge?.pendingPlayerId === myId && (
            <div style={{ padding: '0.5rem 1rem', borderRadius: '8px', backgroundColor: '#fff3cd', border: '1px solid #ffc107', color: '#333' }}>
              Your <strong>{gameState.pendingChallenge!.pendingCardName}</strong> play is pending — waiting for opponents to respond...
            </div>
          )}
        </div>

        {/* Row 3 — board: party leader (left) | party (center) | active monsters (right) */}
        {isInGame && gameState ? (
          <div className="gameBoard">
            <div className="boardLeft">
              <PartyLeaderCard
                gameState={gameState}
                myId={myId}
                isMyTurn={isMyTurn}
                onUsePartyLeaderAbility={handleUsePartyLeaderAbility}
                actionMessage={actionMessage}
                setActionMessage={setActionMessage}
                modalOpen={leaderModalOpen}
                setModalOpen={setLeaderModalOpen}
                abilityPromptActive={!!abilityPrompt}
              />
              <div className="boardLeftActions">
                <EndTurnButton gameState={gameState} myId={myId} handleEndTurn={handleEndTurn} />
                {import.meta.env.DEV && (
                  <button
                    type="button"
                    onClick={handleQuit}
                    style={{ boxSizing: 'border-box', padding: '0.6rem 0.75rem', fontSize: '0.9rem', backgroundColor: '#ff6b6b', color: 'white', border: 'none', borderRadius: '8px', cursor: 'pointer' }}
                  >
                    Quit Game
                  </button>
                )}
              </div>
            </div>
            <div className="boardCenter">
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
            </div>
            <div className="boardRight">
              <div className="boardRightMonsters">
                <ActiveMonstersSidebarCard
                  gameState={gameState}
                  myId={myId}
                  isMyTurn={isMyTurn}
                  selectedMonsterId={selectedMonsterId}
                  setSelectedMonsterId={setSelectedMonsterId}
                  onAttackMonster={handleAttackMonster}
                />
              </div>
            </div>
          </div>
        ) : (
          <div className="gameBoardPre">
            <div className="boardPreGrid">
              <aside className="boardPreLeft">
                <div style={{ padding: '1rem', border: '1px solid #ccc', borderRadius: '8px', backgroundColor: 'white' }}>
                  <h3>Players ({players.length}/{MAX_PLAYERS})</h3>
                  <div style={{ display: 'grid', gap: '0.5rem' }}>
                    {players.map((player, index) => {
                      const isLeader = player.id === gameState?.lobbyLeaderId;
                      const isMe = player.id === myId;
                      const isAway = player.connected === false;
                      const displayName = player.username || player.id;
                      return (
                        <div key={player.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.6rem', borderRadius: '8px', border: '1px solid #e2e8f0', backgroundColor: isMe ? '#eff6ff' : 'white', opacity: isAway ? 0.55 : 1 }}>
                          <div style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', backgroundColor: AVATAR_COLORS[index % AVATAR_COLORS.length], color: 'white', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700 }}>
                            {displayName.charAt(0).toUpperCase()}
                          </div>
                          <span style={{ fontWeight: isMe ? 700 : 400, color: '#1e293b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {displayName}{isMe ? ' (you)' : ''}
                          </span>
                          {isLeader && <span title="Lobby leader">👑</span>}
                          {isAway ? (
                            <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '999px', color: '#92400e', backgroundColor: '#fef3c7' }}>
                              Reconnecting…
                            </span>
                          ) : gameState?.status === 'waiting' && !isLeader && (
                            <span style={{ marginLeft: 'auto', flexShrink: 0, fontSize: '0.75rem', fontWeight: 700, padding: '0.15rem 0.5rem', borderRadius: '999px', color: player.ready ? '#166534' : '#64748b', backgroundColor: player.ready ? '#dcfce7' : '#f1f5f9' }}>
                              {player.ready ? '✓ Ready' : 'Not ready'}
                            </span>
                          )}
                        </div>
                      );
                    })}
                    {gameState?.status === 'waiting' && Array.from({ length: Math.max(0, MAX_PLAYERS - players.length) }).map((_, i) => (
                      <div key={`empty-${i}`} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.4rem 0.6rem', borderRadius: '8px', border: '1px dashed #cbd5e1', color: '#94a3b8' }}>
                        <div style={{ width: 32, height: 32, flexShrink: 0, borderRadius: '50%', border: '1px dashed #cbd5e1', boxSizing: 'border-box' }} />
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
                  <div style={{ padding: '2rem', borderRadius: '12px', backgroundColor: '#d4edda', border: '2px solid #28a745', textAlign: 'center' }}>
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
                        {startHint && <span style={{ color: '#64748b', fontSize: '0.9rem' }}>{startHint}</span>}
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
                        <span style={{ color: '#64748b', fontSize: '0.9rem' }}>
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
        )}

        {/* Row 4 — footer: deck/discard (left) | hand button | opponents (right) */}
        {isInGame && gameState && (
          <footer className="gameFooter">
            <div className="footerLeft">
              <MainDeckCard
                gameState={gameState}
                myId={myId}
                showDrawPrompt={showDrawPrompt}
                setShowDrawPrompt={setShowDrawPrompt}
                handleDrawFromMain={handleDrawFromMain}
                handleMulligan={handleMulligan}
              />
              <DiscardPileCard
                gameState={gameState}
                showDiscardPile={showDiscardPile}
                setShowDiscardPile={setShowDiscardPile}
              />
            </div>
            <div className="footerHand">
              <HandFan gameState={gameState} myId={myId} onCardClick={setHandDetailId} />
            </div>
            <div className="footerChat">
              <ChatLogPanel gameState={gameState} entries={gameState.gameLog ?? []} myId={myId} onSend={handleSendChat} />
            </div>
          </footer>
        )}
      </div>
    </div>
  );
}
