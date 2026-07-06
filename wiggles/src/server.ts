// server.ts — extracted from the original monolithic server.ts.
import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import type {
  ClientToServerEvents, ServerToClientEvents,
  Effect, GameState, MonsterInstance,
} from '../../shared/src/types.js';
import { logEvent, nameOf } from './log.js';
import { drawCards, initializeDecks, loadAllCardTemplates } from './cards.js';
import {
  rooms, getRoomState, setIo, getIo, emitAbilityPrompt, buildPromptId,
  pendingChallenges, modifierPhases, heroesPlayedFromAbilityThisTurn, markHeroPlayedFromAbility,
} from './state.js';
import type { AbilityPromptOption } from './state.js';
import {
  getHeroEffectiveClass, decrementTemporaryModifiers, applyWinIfMet,
  playerHasSlainEffectFlag, playerHasSlainEffectAction,
} from './util.js';
import { drawCardsForPlayer, activateHeroAbility, triggerSlainMonsterPassive } from './effects.js';
import { processMagicCardSteps } from './magic.js';
import { checkMonsterRequirements, executeMonsterAttackRoll } from './monsters.js';
import {
  getModifierAmount, getModifierChoiceLabel, modifierDiscardsHand, updateModifierPhaseGameState,
  finalizeRoll, advanceModifierQueue, getSlainOpponentModifierBonus, executeRollAndEmit,
} from './rolls.js';
import {
  getEligibleChallengerIds, getChallengeCardBonus, openChallengeWindow,
  executePendingCardPlay, resolveChallengeRollOff,
} from './challenges.js';
import { handlePromptResponse, handleMultiPromptResponse } from './promptResponse.js';


// Falls back to the Vite dev server origin for local development. In production,
// set CORS_ORIGIN to the deployed frontend origin. Must be an explicit origin
// (not "*") because the client connects with credentials.
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:5173';

const app = express();
app.use(cors({origin: CORS_ORIGIN, credentials: true}));
app.use(express.json());

const generateRoomCode = (): string => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
};

const createInitialGameState = (roomCode: string): GameState => ({
  gameId: roomCode,
  status: 'waiting',
  activePlayerId: '',
  turnNumber: 0,
  phase: 'DRAW',
  players: {},
  stack: [],
  monsterDeck: [],
  partyLeaderDeck: [],
  mainDeck: [],
  activeMonsters: [],
  discardedMonsters: [],
  discardPile: [],
  cardTemplates: loadAllCardTemplates(),
  diceRolls: {},
  availablePartyLeaderCards: [],
  partyLeaderSelectionOrder: [],
  currentSelectionPlayerId: undefined,
  rollWinnerId: undefined,
  lobbyLeaderId: undefined,
  currentRollerId: undefined,
  firstPlayerId: undefined,
  targetMonstersToWin: undefined,
  gameLog: []
});

app.post('/api/create-room', (_req, res) => {
  let roomCode = generateRoomCode();
  while (rooms[roomCode]) {
    roomCode = generateRoomCode();
  }
  rooms[roomCode] = createInitialGameState(roomCode);
  res.json({ roomCode });
});

app.get('/api/room/:roomCode', (req, res) => {
  const roomCode = req.params.roomCode?.toUpperCase();
  res.json({ exists: Boolean(getRoomState(roomCode)) });
});

const httpServer = createServer(app);
const API_URL = CORS_ORIGIN;

// Apply the types to the Socket Server
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: API_URL,
    methods: ["GET", "POST"],
    credentials: true
  }
});

// Register the io instance so state.ts (and through it every engine module) can
// resolve sockets without importing the entrypoint.
setIo(io);

// The per-connection handler. Exported so tests can drive it with a fake socket
// (and fake io via setIo) without booting a real server. It resolves the live io
// through getIo() so broadcasts go to whichever server instance is registered.
const handleConnection = (socket: Socket) => {
  const roomCode = (socket.handshake.auth.roomCode as string | undefined)?.toUpperCase();
  const username = socket.handshake.auth.username as string | undefined;
  const gameState = getRoomState(roomCode);

  if (!roomCode || !gameState) {
    socket.emit('roomNotFound', 'Room not found or room code missing.');
    socket.disconnect();
    return;
  }

  const isExistingPlayer = !!gameState.players[socket.id];
  if (!isExistingPlayer && Object.keys(gameState.players).length >= 6) {
    socket.emit('roomFull', 'This room is full (6 players max).');
    socket.disconnect();
    return;
  }

  socket.data.roomCode = roomCode;
  socket.join(roomCode);

  const player = gameState.players[socket.id];
  if (!player) {
    gameState.players[socket.id] = {
      id: socket.id,
      username,
      ready: false,
      actionPoints: 3,
      partyLeaderId: undefined,
      slainMonsters: [],
      zones: {
        hand: [],
        party: [],
      }
    };
  } else if (username) {
    player.username = username;
  }

  if (!gameState.activePlayerId) {
    gameState.activePlayerId = socket.id;
  }

  if (!gameState.lobbyLeaderId) {
    gameState.lobbyLeaderId = socket.id;
  }

  const sendRoomUpdate = () => {
    const current = getRoomState(roomCode);
    if (!current) return;
    getIo().to(roomCode).emit('stateUpdate', current);
    getIo().to(roomCode).emit('playersUpdated', Object.values(current.players));
  };

  sendRoomUpdate();

  socket.on('sendChat', (message) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;
    const sender = gameState.players[socket.id];
    if (!sender) return;
    const text = (message ?? '').toString().trim().slice(0, 500);
    if (!text) return;
    logEvent(gameState, 'chat', text, { id: socket.id, username: sender.username });
    sendRoomUpdate();
  });

  socket.on('toggleReady', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'waiting') return;
    const player = gameState.players[socket.id];
    if (!player) return;
    player.ready = !player.ready;
    sendRoomUpdate();
  });

  socket.on('startGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'waiting') {
      return;
    }

    if (Object.keys(gameState.players).length < 2) {
      socket.emit('actionFailed', 'Need at least 2 players to start.');
      return;
    }

    // The lobby leader starts the game, so only everyone else has to ready up.
    const allReady = Object.values(gameState.players)
      .every(p => p.id === gameState.lobbyLeaderId || p.ready);
    if (!allReady) {
      socket.emit('actionFailed', 'All players must be ready before starting.');
      return;
    }

    const { monsterDeck, partyLeaderDeck, mainDeck } = initializeDecks();
    gameState.monsterDeck = monsterDeck;
    gameState.partyLeaderDeck = partyLeaderDeck;
    gameState.mainDeck = mainDeck;
    gameState.discardPile = [];
    gameState.discardedMonsters = [];
    gameState.activeMonsters = drawCards(gameState.monsterDeck, 3) as MonsterInstance[];

    const playerIds = Object.keys(gameState.players);
    for (const playerId of playerIds) {
      const player = gameState.players[playerId];
      if (!player) continue;
      const cards = drawCards(gameState.mainDeck, 5);
      player.zones.hand.push(...cards);
      player.ready = false;
    }

    gameState.status = 'rolling';
    gameState.diceRolls = {};
    gameState.availablePartyLeaderCards = [];
    gameState.partyLeaderSelectionOrder = [];
    gameState.currentSelectionPlayerId = undefined;
    gameState.currentRollerId = playerIds[0] ?? undefined;
    gameState.turnNumber = 0;
    logEvent(gameState, 'system', `${nameOf(gameState, socket.id)} started the game.`, { id: socket.id, username: gameState.players[socket.id]?.username });

    sendRoomUpdate();
  });

  socket.on('drawFromMain', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot draw now.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn to draw.');
      return;
    }

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to draw a card.');
      return;
    }

    if (gameState.mainDeck.length === 0) {
      socket.emit('actionFailed', 'No cards to draw.');
      return;
    }

    const card = drawCardsForPlayer(gameState, player, 1)[0];
    if (!card) return;

    player.actionPoints = (player.actionPoints ?? 0) - 1;
    logEvent(gameState, 'action', `${nameOf(gameState, socket.id)} drew a card.`, { id: socket.id, username: player.username });

    socket.emit('cardDrawn', { instanceId: card.instanceId, templateId: card.templateId });

    sendRoomUpdate();
  });

  socket.on('mulligan', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) return;
    if ((player.actionPoints ?? 0) < 3) {
      socket.emit('actionFailed', 'Not enough AP to mulligan (costs 3 AP).');
      return;
    }
    if (gameState.mainDeck.length < 5) {
      socket.emit('actionFailed', 'Not enough cards in the deck to mulligan.');
      return;
    }

    gameState.discardPile.push(...player.zones.hand);
    player.zones.hand = [];
    drawCardsForPlayer(gameState, player, 5);
    player.actionPoints = (player.actionPoints ?? 0) - 3;
    logEvent(gameState, 'action', `${nameOf(gameState, socket.id)} mulliganed their hand.`, { id: socket.id, username: player.username });

    sendRoomUpdate();
  });

  socket.on('playHero', (instanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play hero now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a hero.');
      return;
    }

    const cardIndex = player.zones.hand.findIndex((card) => card.instanceId === instanceId);
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Hero card not found in hand.');
      return;
    }

    const card = player.zones.hand[cardIndex];
    if (!card || card.cardType !== 'hero') {
      socket.emit('actionFailed', 'Only hero cards can be played to your party.');
      return;
    }

    const playedCards = player.zones.hand.splice(cardIndex, 1);
    const playedCard = playedCards[0];
    if (!playedCard) {
      socket.emit('actionFailed', 'Failed to play hero card.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;
    logEvent(gameState, 'action', `${nameOf(gameState, socket.id)} played ${gameState.cardTemplates[playedCard.templateId]?.name ?? 'a hero'}.`, { id: socket.id, username: player.username });

    const roomCode = socket.data.roomCode as string;
    const eligibleChallengerIds = getEligibleChallengerIds(gameState, socket.id);

    if (eligibleChallengerIds.length > 0) {
      openChallengeWindow(roomCode, gameState, {
        pendingCardInstance: playedCard,
        pendingPlayerId: socket.id,
        pendingCardType: 'hero',
        eligibleChallengerIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      player.zones.party.push(playedCard);
      applyWinIfMet(gameState, player, socket.id);
      markHeroPlayedFromAbility(roomCode, playedCard.instanceId);
      socket.emit('heroPlayAccepted', playedCard.instanceId);
    }

    sendRoomUpdate();
  });

  socket.on('playMagic', (cardInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play a magic card now.');
      return;
    }
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) return;
    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a magic card.');
      return;
    }
    const cardIndex = player.zones.hand.findIndex(c => c.instanceId === cardInstanceId);
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Magic card not found in hand.');
      return;
    }
    const card = player.zones.hand[cardIndex];
    if (!card || card.cardType !== 'magic') {
      socket.emit('actionFailed', 'Selected card is not a magic card.');
      return;
    }
    const template = gameState.cardTemplates[card.templateId];
    if (!template?.effect) {
      socket.emit('actionFailed', 'This magic card has no effect defined.');
      return;
    }
    player.actionPoints = (player.actionPoints ?? 0) - 1;
    const [removedMagicCard] = player.zones.hand.splice(cardIndex, 1);
    if (!removedMagicCard) { sendRoomUpdate(); return; }
    logEvent(gameState, 'action', `${nameOf(gameState, socket.id)} played ${template.name ?? 'a magic card'}.`, { id: socket.id, username: player.username });

    const magicRoomCode = socket.data.roomCode as string;
    const steps: Effect[] = template.effect.steps ?? [template.effect as unknown as Effect];
    const magicEligibleIds = getEligibleChallengerIds(gameState, socket.id);

    if (magicEligibleIds.length > 0) {
      openChallengeWindow(magicRoomCode, gameState, {
        pendingCardInstance: removedMagicCard,
        pendingPlayerId: socket.id,
        pendingCardType: 'magic',
        magicSteps: steps,
        eligibleChallengerIds: magicEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      gameState.discardPile.push(removedMagicCard);
      processMagicCardSteps(socket, gameState, player, removedMagicCard.instanceId, steps, undefined, true);
    }

    sendRoomUpdate();
  });

  socket.on('playItem', (itemInstanceId, targetHeroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play item now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play an item.');
      return;
    }

    const itemIndex = player.zones.hand.findIndex((card) => card.instanceId === itemInstanceId);
    if (itemIndex === -1) {
      socket.emit('actionFailed', 'Item not found in hand.');
      return;
    }

    const itemCard = player.zones.hand[itemIndex];
    if (!itemCard || itemCard.cardType !== 'item') {
      socket.emit('actionFailed', 'Only item cards can be equipped to heroes.');
      return;
    }

    const itemTemplate = gameState.cardTemplates[itemCard.templateId];
    if ((itemTemplate?.subtype as string | undefined)?.toLowerCase() === 'cursed') {
      socket.emit('actionFailed', 'Cursed items must be played on opponents using the cursed item flow.');
      return;
    }

    const targetHero = player.zones.party.find((card) => card.instanceId === targetHeroInstanceId);
    if (!targetHero) {
      socket.emit('actionFailed', 'Target hero not found in your party.');
      return;
    }

    if (targetHero.equippedItem) {
      socket.emit('actionFailed', 'That hero already has an equipped item.');
      return;
    }

    const [removedItem] = player.zones.hand.splice(itemIndex, 1);
    if (!removedItem) {
      socket.emit('actionFailed', 'Failed to remove item from hand.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;
    logEvent(gameState, 'action', `${nameOf(gameState, socket.id)} equipped ${itemTemplate?.name ?? 'an item'} to ${gameState.cardTemplates[targetHero.templateId]?.name ?? 'a hero'}.`, { id: socket.id, username: player.username });

    const itemRoomCode = socket.data.roomCode as string;
    const itemEligibleIds = playerHasSlainEffectFlag(gameState, player, 'blockItemChallenges')
      ? []
      : getEligibleChallengerIds(gameState, socket.id);

    if (itemEligibleIds.length > 0) {
      openChallengeWindow(itemRoomCode, gameState, {
        pendingCardInstance: removedItem,
        pendingPlayerId: socket.id,
        pendingCardType: 'item',
        itemTargetPlayerId: socket.id,
        itemTargetHeroInstanceId: targetHeroInstanceId,
        eligibleChallengerIds: itemEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      player.zones.party.push(removedItem);
      targetHero.equippedItem = removedItem.instanceId;
    }

    sendRoomUpdate();
  });

  socket.on('playCursedItem', (itemInstanceId, targetPlayerId, targetHeroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot play cursed item now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    if (socket.id === targetPlayerId) {
      socket.emit('actionFailed', 'Cannot play cursed item on your own heroes.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const targetPlayer = gameState.players[targetPlayerId];
    if (!targetPlayer) {
      socket.emit('actionFailed', 'Target player not found.');
      return;
    }

    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to play a cursed item.');
      return;
    }

    const itemIndex = player.zones.hand.findIndex((card) => card.instanceId === itemInstanceId);
    if (itemIndex === -1) {
      socket.emit('actionFailed', 'Cursed item not found in hand.');
      return;
    }

    const itemCard = player.zones.hand[itemIndex];
    if (!itemCard || itemCard.cardType !== 'item') {
      socket.emit('actionFailed', 'Only item cards can be equipped to heroes.');
      return;
    }

    const itemTemplate = gameState.cardTemplates[itemCard.templateId];
    if ((itemTemplate?.subtype as string | undefined)?.toLowerCase() !== 'cursed') {
      socket.emit('actionFailed', 'Only cursed items can be played on opponent heroes.');
      return;
    }

    const targetHero = targetPlayer.zones.party.find((card) => card.instanceId === targetHeroInstanceId);
    if (!targetHero) {
      socket.emit('actionFailed', 'Target hero not found in opponent\'s party.');
      return;
    }

    if (targetHero.equippedItem) {
      socket.emit('actionFailed', 'That hero already has an equipped item.');
      return;
    }

    const [removedCursedItem] = player.zones.hand.splice(itemIndex, 1);
    if (!removedCursedItem) {
      socket.emit('actionFailed', 'Failed to remove cursed item from hand.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 1;

    const cursedRoomCode = socket.data.roomCode as string;
    const cursedEligibleIds = playerHasSlainEffectFlag(gameState, player, 'blockItemChallenges')
      ? []
      : getEligibleChallengerIds(gameState, socket.id);

    if (cursedEligibleIds.length > 0) {
      openChallengeWindow(cursedRoomCode, gameState, {
        pendingCardInstance: removedCursedItem,
        pendingPlayerId: socket.id,
        pendingCardType: 'item',
        itemTargetPlayerId: targetPlayerId,
        itemTargetHeroInstanceId: targetHeroInstanceId,
        eligibleChallengerIds: cursedEligibleIds,
        passedPlayerIds: new Set(),
        challengerRollBonus: 0,
      });
    } else {
      targetPlayer.zones.party.push(removedCursedItem);
      targetHero.equippedItem = removedCursedItem.instanceId;
    }

    sendRoomUpdate();
  });

  socket.on('playChallenge', (challengeCardInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    const roomCode = socket.data.roomCode as string;
    if (!gameState) return;

    const pending = pendingChallenges.get(roomCode);
    if (!pending) {
      socket.emit('actionFailed', 'No active challenge window.');
      return;
    }
    if (pending.challengerId) {
      socket.emit('actionFailed', 'This card play has already been challenged.');
      return;
    }
    if (!pending.eligibleChallengerIds.includes(socket.id) || pending.passedPlayerIds.has(socket.id)) {
      socket.emit('actionFailed', 'You are not eligible to challenge.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const challengeCard = player.zones.hand.find(
      c => c.instanceId === challengeCardInstanceId && c.cardType === 'challenge'
    );
    if (!challengeCard) {
      socket.emit('actionFailed', 'Challenge card not found in hand.');
      return;
    }

    const template = gameState.cardTemplates[challengeCard.templateId];
    const req = template?.onEvent?.requirement;
    if (req?.cardType === 'hero' && req.class && req.eligibility === 'self') {
      const hasClass = player.zones.party.some(
        partyCard => getHeroEffectiveClass(gameState, player, partyCard) === req.class
      );
      if (!hasClass) {
        socket.emit('actionFailed', `You need a ${req.class} hero in your party to play this challenge card.`);
        return;
      }
    }

    pending.challengerId = socket.id;
    pending.challengeCardInstanceId = challengeCardInstanceId;
    pending.challengerRollBonus = getChallengeCardBonus(template);

    const gsPending = gameState.pendingChallenge;
    if (gsPending) gsPending.challengerId = socket.id;

    const challengedPlayerId = pending.pendingPlayerId;
    resolveChallengeRollOff(roomCode, pending, gameState, sendRoomUpdate);

    // m_009 Bloodwing: if the challenged player has slain a Bloodwing, the
    // challenger must DISCARD a card (resolved after the challenge card is spent).
    const challengedPlayer = gameState.players[challengedPlayerId];
    if (
      challengedPlayer &&
      playerHasSlainEffectAction(gameState, challengedPlayer, 'FORCE_CHALLENGER_DISCARD') &&
      player.zones.hand.length > 0
    ) {
      const opts = player.zones.hand.map(c => ({
        id: c.instanceId,
        label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
        payload: { cardInstanceId: c.instanceId },
      }));
      emitAbilityPrompt(socket.id, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: '',
        sourcePlayerId: socket.id,
        promptType: 'discardCard',
        message: 'Bloodwing: you challenged its owner — discard a card.',
        options: opts,
        effect: { action: 'SLAIN_FORCE_DISCARD' },
        remainingEffects: [],
        isSlainPassive: true,
      });
      sendRoomUpdate();
    }
  });

  socket.on('passChallenge', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    const roomCode = socket.data.roomCode as string;
    if (!gameState) return;

    const pending = pendingChallenges.get(roomCode);
    if (!pending || pending.challengerId) return;
    if (!pending.eligibleChallengerIds.includes(socket.id) || pending.passedPlayerIds.has(socket.id)) return;

    pending.passedPlayerIds.add(socket.id);
    const remaining = pending.eligibleChallengerIds.filter(id => !pending.passedPlayerIds.has(id));

    if (remaining.length === 0) {
      executePendingCardPlay(roomCode, pending, gameState);
      pendingChallenges.delete(roomCode);
      delete gameState.pendingChallenge;
    } else {
      const gsPending = gameState.pendingChallenge;
      if (gsPending) gsPending.eligibleChallengerIds = remaining;
    }

    sendRoomUpdate();
  });

  socket.on('playModifier', (modifierInstanceId, choiceIndex) => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    if (pendingChallenges.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot play a modifier during a challenge window.');
      return;
    }

    const phase = modifierPhases.get(roomCode);
    if (!phase) {
      socket.emit('actionFailed', 'No active modifier phase.');
      return;
    }

    const isRollerTurn = phase.phase === 'roller_turn' && socket.id === phase.rollingPlayerId;
    const isOpponentTurn = phase.phase === 'opponent_turn' && phase.opponentQueue[0] === socket.id;
    if (!isRollerTurn && !isOpponentTurn) {
      socket.emit('actionFailed', 'It is not your turn to play a modifier.');
      return;
    }

    // h_002 Shadow Saint: no player other than the active player may play
    // Modifier cards until the end of the active player's turn.
    if (gameState.roomFlags?.lockModifiers && socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Modifier cards are locked for other players this turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const cardIndex = player.zones.hand.findIndex(c => c.instanceId === modifierInstanceId && c.cardType === 'modifier');
    if (cardIndex === -1) {
      socket.emit('actionFailed', 'Modifier card not found in hand.');
      return;
    }

    const [card] = player.zones.hand.splice(cardIndex, 1);
    if (!card) return;
    gameState.discardPile.push(card);

    const template = gameState.cardTemplates[card.templateId];
    const amount = getModifierAmount(template, choiceIndex, phase.rollContext);
    const choiceLabel = getModifierChoiceLabel(template, choiceIndex, phase.rollContext);
    phase.accumulatedModifier += amount;
    // mod_007 "DISCARD your hand, +7": the player discards the rest of their hand.
    if (modifierDiscardsHand(template, choiceIndex, phase.rollContext) && player.zones.hand.length > 0) {
      gameState.discardPile.push(...player.zones.hand);
      player.zones.hand = [];
    }
    // p_004 Protecting Horn: +1 (or -1 matching direction) when THIS player plays a modifier
    if (amount !== 0 && player.partyLeaderId) {
      const plTemplate = gameState.cardTemplates[player.partyLeaderId];
      if (plTemplate?.effect?.triggerEvent === 'ON_MODIFIER_PLAYED') {
        phase.accumulatedModifier += amount > 0 ? 1 : -1;
      }
    }
    // m_017 Abyss Queen: when an OPPONENT plays a modifier on the roller's roll,
    // the roller gains a flat bonus to that roll.
    if (socket.id !== phase.rollingPlayerId) {
      const roller = gameState.players[phase.rollingPlayerId];
      if (roller) phase.accumulatedModifier += getSlainOpponentModifierBonus(gameState, roller);
    }

    phase.modifiersPlayed.push({
      playerName: player.username ?? socket.id,
      cardName: template?.name ?? card.templateId,
      amount,
      choiceLabel,
    });

    // m_006 Crowned Serpent: each time ANY player plays a modifier, every player
    // who has slain a Crowned Serpent may draw a card.
    for (const pid of Object.keys(gameState.players)) {
      triggerSlainMonsterPassive(gameState, pid, 'ON_MODIFIER_PLAYED_ANY');
    }

    if (phase.phase === 'opponent_turn') phase.cardPlayedThisCycle = true;

    if (phase.phase === 'roller_turn') {
      const newTotal = phase.rawDiceTotal + phase.persistentBonus + phase.accumulatedModifier;
      if (newTotal >= phase.requiredRoll) {
        phase.phase = 'opponent_turn';
        phase.opponentQueue = phase.allOpponentsWithModifiers.filter(
          pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
        );
        phase.cardPlayedThisCycle = false;
        if (phase.opponentQueue.length === 0) {
          finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
          return;
        }
      }
    }

    updateModifierPhaseGameState(roomCode, phase, gameState);
    sendRoomUpdate();
  });

  socket.on('passModifier', () => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    const phase = modifierPhases.get(roomCode);
    if (!phase) {
      socket.emit('actionFailed', 'No active modifier phase.');
      return;
    }

    const isRollerTurn = phase.phase === 'roller_turn' && socket.id === phase.rollingPlayerId;
    const isOpponentTurn = phase.phase === 'opponent_turn' && phase.opponentQueue[0] === socket.id;
    if (!isRollerTurn && !isOpponentTurn) {
      socket.emit('actionFailed', 'It is not your turn to pass.');
      return;
    }

    if (phase.phase === 'roller_turn') {
      phase.phase = 'opponent_turn';
      phase.opponentQueue = phase.allOpponentsWithModifiers.filter(
        pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
      );
      phase.cardPlayedThisCycle = false;
      if (phase.opponentQueue.length === 0) {
        finalizeRoll(roomCode, phase, gameState, sendRoomUpdate);
        return;
      }
      updateModifierPhaseGameState(roomCode, phase, gameState);
      sendRoomUpdate();
      return;
    }

    advanceModifierQueue(roomCode, phase, gameState, sendRoomUpdate);
  });

  socket.on('usePartyLeaderAbility', () => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    if (pendingChallenges.has(roomCode) || modifierPhases.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot use party leader ability during an active roll or challenge.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const partyLeaderCard = player.zones.party.find(c => c.cardType === 'party_leader');
    if (!partyLeaderCard) {
      socket.emit('actionFailed', 'No party leader in play.');
      return;
    }
    if (partyLeaderCard.effectUsedThisTurn) {
      socket.emit('actionFailed', 'Party leader ability already used this turn.');
      return;
    }

    const template = gameState.cardTemplates[partyLeaderCard.templateId];
    if (!template?.effect?.isOptional) {
      socket.emit('actionFailed', 'This party leader ability triggers automatically.');
      return;
    }

    const apCost = typeof template.effect.apCost === 'number' ? template.effect.apCost : 0;
    if (apCost > 0 && (player.actionPoints ?? 0) < apCost) {
      socket.emit('actionFailed', `Not enough AP (costs ${apCost} AP).`);
      return;
    }
    if (apCost > 0) {
      player.actionPoints = (player.actionPoints ?? 0) - apCost;
    }

    if (template.effect.action === 'STEAL_CARD') {
      const opponents = Object.entries(gameState.players).filter(
        ([id, p]) => id !== socket.id && p.zones.hand.length > 0
      );
      if (opponents.length === 0) {
        player.actionPoints = (player.actionPoints ?? 0) + apCost;
        socket.emit('actionFailed', 'No opponents have cards to steal.');
        return;
      }
      const options: AbilityPromptOption[] = opponents.map(([id, p]) => ({
        id: `player_${id}`,
        label: `${p.username ?? id} (${p.zones.hand.length} card${p.zones.hand.length !== 1 ? 's' : ''})`,
        payload: { playerId: id },
      }));
      emitAbilityPrompt(socket.id, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: partyLeaderCard.instanceId,
        sourcePlayerId: socket.id,
        promptType: 'selectPlayer',
        message: 'Choose an opponent to steal a card from.',
        options,
        effect: { action: 'STEAL_CARD' },
        remainingEffects: [],
        isPartyLeaderAbility: true,
      });
    } else if (template.effect.action === 'SEARCH_DISCARD') {
      if (gameState.discardPile.length === 0) {
        player.actionPoints = (player.actionPoints ?? 0) + apCost;
        socket.emit('actionFailed', 'The discard pile is empty.');
        return;
      }
      const options: AbilityPromptOption[] = gameState.discardPile.map((card) => {
        const t = gameState.cardTemplates[card.templateId];
        return {
          id: card.instanceId,
          label: t?.name ?? card.templateId,
          payload: { cardInstanceId: card.instanceId },
        };
      });
      emitAbilityPrompt(socket.id, {
        promptId: buildPromptId(),
        roomCode,
        heroInstanceId: partyLeaderCard.instanceId,
        sourcePlayerId: socket.id,
        promptType: 'selectCard',
        message: 'Choose a card from the discard pile to add to your hand.',
        options,
        effect: { action: 'SEARCH_DISCARD' },
        remainingEffects: [],
        isPartyLeaderAbility: true,
      });
    }
    sendRoomUpdate();
  });

  socket.on('attackMonster', (monsterInstanceId) => {
    const roomCode = socket.data.roomCode as string;
    const gameState = getRoomState(roomCode);
    if (!gameState || gameState.status !== 'in_progress') return;

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    if (pendingChallenges.has(roomCode) || modifierPhases.has(roomCode)) {
      socket.emit('actionFailed', 'Cannot attack while another action is pending.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    if ((player.actionPoints ?? 0) < 2) {
      socket.emit('actionFailed', 'Not enough AP to attack a monster (costs 2 AP).');
      return;
    }

    const monster = gameState.activeMonsters.find(m => m.instanceId === monsterInstanceId);
    if (!monster) {
      socket.emit('actionFailed', 'Monster not found.');
      return;
    }

    const monsterTemplate = gameState.cardTemplates[monster.templateId];
    const reqCheck = checkMonsterRequirements(gameState, player, monsterTemplate);
    if (!reqCheck.met) {
      socket.emit('actionFailed', `Requirements not met: ${reqCheck.missing}`);
      return;
    }
    if (!monsterTemplate) {
      socket.emit('actionFailed', 'Monster template not found.');
      return;
    }

    player.actionPoints = (player.actionPoints ?? 0) - 2;
    logEvent(gameState, 'action', `${nameOf(gameState, socket.id)} is attacking ${monsterTemplate.name ?? 'a monster'}.`, { id: socket.id, username: player.username });
    executeMonsterAttackRoll(roomCode, socket, gameState, player, monster, monsterTemplate, sendRoomUpdate);
  });

  socket.on('rollHeroAbility', (heroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot roll hero ability now.');
      return;
    }

    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    const hero = player.zones.party.find((card) => card.instanceId === heroInstanceId);
    if (!hero || hero.cardType !== 'hero') {
      socket.emit('actionFailed', 'Hero not found in your party.');
      return;
    }

    if (hero.effectUsedThisTurn) {
      socket.emit('actionFailed', 'This hero ability has already been used this turn.');
      return;
    }

    const playedFromAbility = heroesPlayedFromAbilityThisTurn.get(socket.data.roomCode as string)?.has(heroInstanceId) ?? false;
    if (!playedFromAbility) {
      if ((player.actionPoints ?? 0) < 1) {
        socket.emit('actionFailed', 'Not enough AP to use a hero ability.');
        return;
      }
      player.actionPoints = (player.actionPoints ?? 0) - 1;
    }

    let preRollBonus = 0;
    const equippedItemId = hero.equippedItem;
    if (equippedItemId) {
      const itemInstance = player.zones.party.find(c => c.instanceId === equippedItemId);
      if (itemInstance) {
        const itemTemplate = gameState.cardTemplates[itemInstance.templateId];

        const passives = itemTemplate?.passiveModifiers;
        if (passives?.some(p => p.stat === 'heroEffectLocked')) {
          if (!playedFromAbility) player.actionPoints = (player.actionPoints ?? 0) + 1;
          socket.emit('actionFailed', 'This hero\'s effect is locked by an equipped item.');
          sendRoomUpdate();
          return;
        }

        // ci_005 Soulbound Grimoire: rolling this hero's effect costs a fixed total
        // of AP (default 2). Charge the difference beyond the base cost already paid.
        const rollCostPassive = passives?.find(p => p.stat === 'rollCostAP');
        if (rollCostPassive) {
          const totalCost = typeof rollCostPassive.value === 'number' ? rollCostPassive.value : 2;
          const alreadyPaid = playedFromAbility ? 0 : 1;
          const extra = totalCost - alreadyPaid;
          if (extra > 0) {
            if ((player.actionPoints ?? 0) < extra) {
              if (!playedFromAbility) player.actionPoints = (player.actionPoints ?? 0) + 1; // refund base
              socket.emit('actionFailed', `Rolling this hero's effect costs ${totalCost} AP (cursed item).`);
              sendRoomUpdate();
              return;
            }
            player.actionPoints = (player.actionPoints ?? 0) - extra;
          }
        }

        const itemTrigger = itemTemplate?.trigger;
        if (itemTrigger?.event === 'ON_HERO_ROLL_ATTEMPT' && itemTrigger.scope === 'equipped_hero') {
          const modifyEffect = itemTrigger.effects.find(e => e.action === 'MODIFY_ROLL');
          if (modifyEffect) {
            if (!itemTrigger.optional) {
              preRollBonus += modifyEffect.amount ?? 0;
            } else {
              const maxDiscard = (itemTrigger.cost?.[0]?.max as number | undefined) ?? 3;
              const minDiscard = (itemTrigger.cost?.[0]?.min as number | undefined) ?? 0;
              const bonusPerCard = modifyEffect.amount ?? 0;
              const availableMax = Math.min(maxDiscard, player.zones.hand.length);
              if (availableMax < 1) {
                // Nothing to discard — just roll with no bonus.
                executeRollAndEmit(socket, gameState, player, hero, 0, sendRoomUpdate);
                return;
              }
              const cardOptions: AbilityPromptOption[] = player.zones.hand.map(c => ({
                id: c.instanceId,
                label: gameState.cardTemplates[c.templateId]?.name || c.templateId,
                payload: { cardInstanceId: c.instanceId },
              }));
              emitAbilityPrompt(socket.id, {
                promptId: buildPromptId(),
                roomCode: socket.data.roomCode as string,
                heroInstanceId: hero.instanceId,
                sourcePlayerId: socket.id,
                promptType: 'multiSelectCard',
                message: `${itemTemplate?.name ?? itemInstance.templateId}: select up to ${availableMax} card${availableMax > 1 ? 's' : ''} to discard for +${bonusPerCard} each, then confirm.`,
                options: cardOptions,
                minSelections: minDiscard,
                maxSelections: availableMax,
                effect: { action: 'ITEM_I004_DISCARD_SELECT', bonusPerCard },
                remainingEffects: [],
                isItemTrigger: true,
                itemInstanceId: itemInstance.instanceId,
              });
              sendRoomUpdate();
              return;
            }
          }
        }
      }
    }

    executeRollAndEmit(socket, gameState, player, hero, preRollBonus, sendRoomUpdate);
  });

  socket.on('activateHeroAbility', (heroInstanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn.');
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) return;

    activateHeroAbility(socket, gameState, heroInstanceId, sendRoomUpdate);
  });

  socket.on('respondToAbilityPrompt', (promptId, selectedOptionId) => {
    handlePromptResponse(socket, promptId, selectedOptionId, sendRoomUpdate);
  });

  socket.on('respondToAbilityPromptMulti', (promptId, selectedOptionIds) => {
    handleMultiPromptResponse(socket, promptId, selectedOptionIds, sendRoomUpdate);
  });

  socket.on('rollForFirst', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'rolling' || !gameState.currentRollerId) {
      return;
    }

    if (socket.id !== gameState.currentRollerId) {
      return;
    }

      const player = gameState.players[socket.id];
      if (!player) return;

    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    const total = die1 + die2;

    // Initial "roll for first" should not include any temporary roll bonuses.
    gameState.diceRolls[socket.id] = total;

    const playerIds = Object.keys(gameState.players);
    const rolledPlayerIds = Object.keys(gameState.diceRolls);
    const nextRollerIndex = playerIds.findIndex(id => !rolledPlayerIds.includes(id));

    if (nextRollerIndex >= 0) {
      gameState.currentRollerId = playerIds[nextRollerIndex] ?? undefined;
    } else {
      let maxRoll = 0;
      let winnerId = '';

      for (const [playerId, roll] of Object.entries(gameState.diceRolls)) {
        if (roll > maxRoll) {
          maxRoll = roll;
          winnerId = playerId;
        }
      }

      gameState.activePlayerId = winnerId;
      gameState.firstPlayerId = winnerId;
      gameState.currentRollerId = undefined;
      gameState.rollWinnerId = winnerId;
      gameState.turnNumber = 1;
      gameState.phase = 'DRAW';
      gameState.status = 'roll_complete';
    }

    sendRoomUpdate();
  });

  socket.on('continueGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    if (gameState.status !== 'roll_complete' && gameState.status !== 'party_leader_review') {
      return;
    }

    if (socket.id !== gameState.lobbyLeaderId) {
      return;
    }

    if (gameState.status === 'roll_complete') {
      const allPlayerIds = Object.keys(gameState.players);
      const firstPlayer = gameState.firstPlayerId ?? allPlayerIds[0] ?? '';
      const selectionOrder = firstPlayer
        ? [firstPlayer, ...allPlayerIds.filter((id) => id !== firstPlayer)]
        : [...allPlayerIds];

      gameState.status = 'party_leader_selection';
      gameState.availablePartyLeaderCards = [...gameState.partyLeaderDeck];
      gameState.partyLeaderSelectionOrder = selectionOrder;
      gameState.currentSelectionPlayerId = selectionOrder[0];
      gameState.diceRolls = {};
    } else {
      gameState.status = 'in_progress';
      gameState.activePlayerId = gameState.firstPlayerId ?? Object.keys(gameState.players)[0] ?? '';
      for (const pid of Object.keys(gameState.players)) {
        const p = gameState.players[pid];
        if (!p) continue;
        p.actionPoints = 3;
      }
    }

    sendRoomUpdate();
  });

  socket.on('endTurn', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) return;
    if (pendingChallenges.has(socket.data.roomCode as string)) {
      socket.emit('actionFailed', 'Cannot end turn while a challenge is pending.');
      return;
    }
    if (modifierPhases.has(socket.data.roomCode as string)) {
      socket.emit('actionFailed', 'Cannot end turn during a modifier phase.');
      return;
    }

      const currentPlayer = gameState.players[socket.id];
      if (currentPlayer) {
        decrementTemporaryModifiers(currentPlayer);
      }

    const playerIds = Object.keys(gameState.players);
    if (playerIds.length === 0) return;

    const currentIndex = playerIds.findIndex((id) => id === socket.id);
    const nextIndex = (currentIndex + 1) % playerIds.length;
    const nextPlayerId = playerIds[nextIndex] ?? '';

    gameState.activePlayerId = nextPlayerId;
    gameState.turnNumber = (gameState.turnNumber ?? 0) + 1;

    const nextPlayer = nextPlayerId ? gameState.players[nextPlayerId] : undefined;
    if (nextPlayer) {
      nextPlayer.actionPoints = 3;
      for (const slainMonster of nextPlayer.slainMonsters ?? []) {
        const mt = gameState.cardTemplates[slainMonster.templateId];
        if (mt?.slainEffect?.action === 'EXTRA_AP') nextPlayer.actionPoints += mt.slainEffect.amount ?? 0;
      }
      // Reset ability usage flags for new active player
      nextPlayer.zones.party.forEach((card) => {
        card.effectUsedThisTurn = false;
      });
      nextPlayer.zones.hand.forEach((card) => {
        card.effectUsedThisTurn = false;
      });
    }

    heroesPlayedFromAbilityThisTurn.delete(socket.data.roomCode as string);
    delete gameState.roomFlags;

    logEvent(gameState, 'system', `${nameOf(gameState, socket.id)} ended their turn. It is now ${nameOf(gameState, nextPlayerId)}'s turn.`, { id: socket.id, username: currentPlayer?.username });

    sendRoomUpdate();
  });

  socket.on('choosePartyLeader', (instanceId) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState || gameState.status !== 'party_leader_selection') {
      return;
    }

    if (socket.id !== gameState.currentSelectionPlayerId) {
      return;
    }

    const cardIndex = gameState.availablePartyLeaderCards.findIndex(
      (card) => card.instanceId === instanceId
    );

    if (cardIndex === -1) {
      return;
    }

    const chosenCard = gameState.availablePartyLeaderCards.splice(cardIndex, 1)[0];
    if (!chosenCard) {
      return;
    }
    const player = gameState.players[socket.id];
    if (!player) {
      return;
    }

    player.zones.party = [chosenCard];
    player.partyLeaderId = chosenCard.templateId;
    logEvent(gameState, 'system', `${nameOf(gameState, socket.id)} chose ${gameState.cardTemplates[chosenCard.templateId]?.name ?? 'a party leader'} as their party leader.`, { id: socket.id, username: player.username });

    const currentIndex = gameState.partyLeaderSelectionOrder.findIndex(
      (id) => id === socket.id
    );
    const nextIndex = currentIndex + 1;

    if (nextIndex < gameState.partyLeaderSelectionOrder.length) {
      gameState.currentSelectionPlayerId = gameState.partyLeaderSelectionOrder[nextIndex];
    } else {
      gameState.currentSelectionPlayerId = undefined;
      gameState.status = 'party_leader_review';
      if (gameState.activeMonsters.length === 0) {
        gameState.activeMonsters = drawCards(gameState.monsterDeck, 3) as MonsterInstance[];
      }
    }

    sendRoomUpdate();
  });

  socket.on('quitGame', () => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (!gameState) return;

    gameState.status = 'waiting';
    gameState.activePlayerId = gameState.lobbyLeaderId || '';
    gameState.turnNumber = 0;
    gameState.phase = 'DRAW';
    gameState.stack = [];
    gameState.monsterDeck = [];
    gameState.partyLeaderDeck = [];
    gameState.mainDeck = [];
    gameState.activeMonsters = [];
    gameState.discardedMonsters = [];
    gameState.discardPile = [];
    gameState.diceRolls = {};
    pendingChallenges.delete(socket.data.roomCode as string);
    delete gameState.pendingChallenge;
    modifierPhases.delete(socket.data.roomCode as string);
    delete gameState.modifierPhase;
    gameState.currentRollerId = undefined;
    gameState.firstPlayerId = undefined;
    gameState.rollWinnerId = undefined;
    gameState.availablePartyLeaderCards = [];
    gameState.partyLeaderSelectionOrder = [];
    gameState.currentSelectionPlayerId = undefined;

    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
      if (!player) continue;
      player.zones.hand = [];
      player.zones.party = [];
      player.actionPoints = 3;
      player.partyLeaderId = undefined;
      player.slainMonsters = [];
      player.ready = false;
    }

    // Fresh game back in the lobby — start the log over with the reset notice.
    gameState.gameLog = [];
    logEvent(gameState, 'system', `${nameOf(gameState, socket.id)} reset the game.`, { id: socket.id, username: gameState.players[socket.id]?.username });

    sendRoomUpdate();
  });

  socket.on('pingServer', () => {
    socket.emit('pongClient', { message: 'Connection successful!' });
  });

  socket.on('setUsername', (username) => {
    const gameState = getRoomState(socket.data.roomCode as string);
    if (gameState) {
      const player = gameState.players[socket.id];
      if (player) {
        player.username = username;
      } else {
        gameState.players[socket.id] = {
          id: socket.id,
          username: username,
          actionPoints: 3,
          partyLeaderId: undefined,
          slainMonsters: [],
          zones: {
            hand: [],
            party: [],
          }
        };
      }
      sendRoomUpdate();
    }
  });

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode as string | undefined;
    if (!roomCode) return;

    const gameState = getRoomState(roomCode);
    if (!gameState) return;

    const wasLobbyLeader = socket.id === gameState.lobbyLeaderId;

    const disconnectPending = pendingChallenges.get(roomCode);
    if (disconnectPending) {
      if (disconnectPending.pendingPlayerId === socket.id) {
        gameState.discardPile.push(disconnectPending.pendingCardInstance);
        pendingChallenges.delete(roomCode);
        delete gameState.pendingChallenge;
      } else if (disconnectPending.eligibleChallengerIds.includes(socket.id)) {
        disconnectPending.passedPlayerIds.add(socket.id);
        const remaining = disconnectPending.eligibleChallengerIds.filter(id => !disconnectPending.passedPlayerIds.has(id));
        if (remaining.length === 0 && !disconnectPending.challengerId) {
          executePendingCardPlay(roomCode, disconnectPending, gameState);
          pendingChallenges.delete(roomCode);
          delete gameState.pendingChallenge;
        } else {
          const gsPending = gameState.pendingChallenge;
          if (gsPending) gsPending.eligibleChallengerIds = remaining;
        }
      }
    }

    const modPhase = modifierPhases.get(roomCode);
    if (modPhase) {
      if (modPhase.rollingPlayerId === socket.id) {
        modifierPhases.delete(roomCode);
        delete gameState.modifierPhase;
      } else if (modPhase.allOpponentsWithModifiers.includes(socket.id)) {
        modPhase.allOpponentsWithModifiers = modPhase.allOpponentsWithModifiers.filter(id => id !== socket.id);
        modPhase.opponentQueue = modPhase.opponentQueue.filter(id => id !== socket.id);
        if (modPhase.phase === 'opponent_turn' && modPhase.opponentQueue.length === 0) {
          if (modPhase.cardPlayedThisCycle) {
            const newQueue = modPhase.allOpponentsWithModifiers.filter(
              pid => gameState.players[pid]?.zones.hand.some(c => c.cardType === 'modifier')
            );
            if (newQueue.length === 0) {
              finalizeRoll(roomCode, modPhase, gameState, sendRoomUpdate);
            } else {
              modPhase.opponentQueue = newQueue;
              modPhase.cardPlayedThisCycle = false;
              updateModifierPhaseGameState(roomCode, modPhase, gameState);
            }
          } else {
            finalizeRoll(roomCode, modPhase, gameState, sendRoomUpdate);
          }
        } else {
          updateModifierPhaseGameState(roomCode, modPhase, gameState);
        }
      }
    }

    delete gameState.players[socket.id];

    if (gameState.activePlayerId === socket.id) {
      gameState.activePlayerId = Object.keys(gameState.players)[0] ?? '';
    }

    if (wasLobbyLeader) {
      gameState.lobbyLeaderId = Object.keys(gameState.players)[0] ?? undefined;
    }

    const room = getIo().sockets.adapter.rooms.get(roomCode);
    const roomCount = room?.size ?? 0;
    if (roomCount === 0) {
      delete rooms[roomCode];
      return;
    }

    sendRoomUpdate();
  });
};

io.on('connection', handleConnection);

// Exported for tests: integration tests listen on an ephemeral port and connect
// real socket.io clients, then close via io.close().
export { handleConnection, httpServer, io };

const PORT = process.env.PORT || 3001;
// Only bind a port when run as the entrypoint. Importing server.ts in tests
// (Vitest sets process.env.VITEST) must not boot a real server.
if (!process.env.VITEST) {
  httpServer.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}
