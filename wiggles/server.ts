import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';

import type { ClientToServerEvents, ServerToClientEvents, CardInstance, GameState, Player, MonsterInstance } from '../shared/types.js'

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const cardsDir = join(__dirname, 'cards');

type CardTemplate = { id: string; type: string; name: string; [key: string]: any };

const shuffle = <T>(items: T[]): T[] => {
  return items.slice().sort(() => Math.random() - 0.5);
};

const loadCardDefinitions = (filename: string): CardTemplate[] => {
  const raw = readFileSync(join(cardsDir, filename), 'utf8');
  const json = JSON.parse(raw) as Record<string, CardTemplate>;
  return Object.values(json);
};

const createCardInstances = (templates: CardTemplate[]): CardInstance[] => {
  return templates.map((template) => ({
    instanceId: `${template.id}-${randomUUID()}`,
    templateId: template.id,
    cardType: mapTemplateType(template.type),
    effectUsedThisTurn: false,
  }));
};

const mapTemplateType = (type: string): CardInstance['cardType'] => {
  const normalized = type.toLowerCase();
  if (normalized === 'partyleader' || normalized === 'party_leader') return 'party_leader';
  if (normalized === 'hero') return 'hero';
  if (normalized === 'item' || normalized === 'cursed_item') return 'item';
  if (normalized === 'magic') return 'magic';
  if (normalized === 'modifier') return 'modifier';
  if (normalized === 'challenge') return 'challenge';
  if (normalized === 'monster') return 'monster';
  return 'magic';
};

const drawCards = (deck: CardInstance[], count: number): CardInstance[] => {
  return deck.splice(0, count);
};

const initializeDecks = () => {
  const monsterTemplates = loadCardDefinitions('monster.json');
  const partyLeaderTemplates = loadCardDefinitions('party_leader.json');
  const mainTemplates = [
    ...loadCardDefinitions('hero.json'),
    ...loadCardDefinitions('item.json'),
    ...loadCardDefinitions('magic.json'),
    ...loadCardDefinitions('modifier.json'),
    ...loadCardDefinitions('challenge.json'),
    ...loadCardDefinitions('cursed_item.json'),
  ];

  return {
    monsterDeck: shuffle(createCardInstances(monsterTemplates)),
    partyLeaderDeck: shuffle(createCardInstances(partyLeaderTemplates)),
    mainDeck: shuffle(createCardInstances(mainTemplates)),
  };
};

const loadAllCardTemplates = (): Record<string, CardTemplate> => {
  const templates: Record<string, CardTemplate> = {};
  const files = ['monster.json', 'party_leader.json', 'hero.json', 'item.json', 'magic.json', 'modifier.json', 'challenge.json', 'cursed_item.json'];
  
  for (const file of files) {
    const raw = readFileSync(join(cardsDir, file), 'utf8');
    const json = JSON.parse(raw) as Record<string, CardTemplate>;
    Object.assign(templates, json);
  }
  
  return templates;
};

const app = express();
app.use(cors());

const httpServer = createServer(app);

// Apply the types to the Socket Server
const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin: "http://localhost:5173",
    methods: ["GET", "POST"]
  }
});

const gameState: GameState = {
  gameId: 'game-1',
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
  targetMonstersToWin: undefined
};

io.on('connection', (socket: Socket) => {
  console.log(`Player connected: ${socket.id}`);
  gameState.players[socket.id] = {
    id: socket.id,
    username: undefined,
    actionPoints: 3,
    partyLeaderId: undefined,
    zones: {
      hand: [],
      party: [],
      discardPile: []
    }
  };

  if (!gameState.activePlayerId) {
    gameState.activePlayerId = socket.id;
  }

  // First player to connect becomes lobby leader
  if (!gameState.lobbyLeaderId) {
    gameState.lobbyLeaderId = socket.id;
  }

  socket.emit('stateUpdate', gameState);
  io.emit('playersUpdated', Object.values(gameState.players));

  socket.on('startGame', () => {
    if (gameState.status !== 'waiting') {
      return;
    }

    if (Object.keys(gameState.players).length === 0) {
      return;
    }

    // Initialize decks
    const { monsterDeck, partyLeaderDeck, mainDeck } = initializeDecks();
    gameState.monsterDeck = monsterDeck;
    gameState.partyLeaderDeck = partyLeaderDeck;
    gameState.mainDeck = mainDeck;
    gameState.discardPile = [];
    gameState.discardedMonsters = [];
    gameState.activeMonsters = drawCards(gameState.monsterDeck, 3) as MonsterInstance[];

    // Draw initial cards for each player
    const playerIds = Object.keys(gameState.players);
    for (const playerId of playerIds) {
      const player = gameState.players[playerId];
      if (!player) continue;
      const cards = drawCards(gameState.mainDeck, 5);
      player.zones.hand.push(...cards);
    }

    // Transition to rolling phase and set first roller
    gameState.status = 'rolling';
    gameState.diceRolls = {};
    gameState.availablePartyLeaderCards = [];
    gameState.partyLeaderSelectionOrder = [];
    gameState.currentSelectionPlayerId = undefined;
    gameState.currentRollerId = playerIds[0] ?? undefined;
    gameState.turnNumber = 0;

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('drawFromMain', () => {
    // Only allow drawing during the main game
    console.log("Drawing from main...");
    if (gameState.status !== 'in_progress') {
      socket.emit('actionFailed', 'Cannot draw now.');
      return;
    }

    const player = gameState.players[socket.id];
    if (!player) return;

    // Only active player may draw
    if (socket.id !== gameState.activePlayerId) {
      socket.emit('actionFailed', 'Not your turn to draw.');
      return;
    }

    // Cost: 1 AP
    if ((player.actionPoints ?? 0) < 1) {
      socket.emit('actionFailed', 'Not enough AP to draw a card.');
      return;
    }

    if (gameState.mainDeck.length === 0) {
      socket.emit('actionFailed', 'No cards to draw.')
      return;
    }

    console.log("Drawing a card for player:", player.username);
    const card = drawCards(gameState.mainDeck, 1)[0];
    console.log(`Card drawn: ${card?.templateId}`);
    if (!card) return;

    player.zones.hand.push(card);
    player.actionPoints = (player.actionPoints ?? 0) - 1;

    // Notify the drawer so the client can play a draw animation
    socket.emit('cardDrawn', { instanceId: card.instanceId, templateId: card.templateId });

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('playHero', (instanceId) => {
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

    player.zones.party.push(playedCard);
    player.actionPoints = (player.actionPoints ?? 0) - 1;

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('rollForFirst', () => {
    if (gameState.status !== 'rolling' || !gameState.currentRollerId) {
      return;
    }

    // Only the current roller can roll
    if (socket.id !== gameState.currentRollerId) {
      return;
    }

    // Roll two d6 dice
    const die1 = Math.floor(Math.random() * 6) + 1;
    const die2 = Math.floor(Math.random() * 6) + 1;
    const total = die1 + die2;

    gameState.diceRolls[socket.id] = total;
    console.log(`${socket.id} rolled: ${die1} + ${die2} = ${total}`);

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

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('continueGame', () => {
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
      // Initialize AP for all players when entering the main game
      for (const pid of Object.keys(gameState.players)) {
        const p = gameState.players[pid];
        if (!p) continue;
        p.actionPoints = 3;
      }
    }

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('endTurn', () => {
    if (gameState.status !== 'in_progress') return;
    if (socket.id !== gameState.activePlayerId) return;

    const playerIds = Object.keys(gameState.players);
    if (playerIds.length === 0) return;

    const currentIndex = playerIds.findIndex((id) => id === socket.id);
    const nextIndex = (currentIndex + 1) % playerIds.length;
    const nextPlayerId = playerIds[nextIndex] ?? '';

    gameState.activePlayerId = nextPlayerId;
    gameState.turnNumber = (gameState.turnNumber ?? 0) + 1;

    // Reset AP for the next player
    const nextPlayer = nextPlayerId ? gameState.players[nextPlayerId] : undefined;
    if (nextPlayer) nextPlayer.actionPoints = 3;

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('choosePartyLeader', (instanceId) => {
    if (gameState.status !== 'party_leader_selection') {
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

    const allPlayerIds = Object.keys(gameState.players);
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

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('quitGame', () => {
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
      player.zones.discardPile = [];
      player.actionPoints = 3;
      player.partyLeaderId = undefined;
    }

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  // TypeScript knows 'pingServer' is a valid event!
  socket.on('pingServer', () => {
    console.log(`Ping received from ${socket.id}`);
    
    // TypeScript forces you to send an object with a 'message' string
    socket.emit('pongClient', { message: "Connection successful!" });
  });

  socket.on('setUsername', (username) => {
    const player = gameState.players[socket.id];
    if (player) {
      player.username = username;
    } else {
      gameState.players[socket.id] = {
        id: socket.id,
        username: username,
        actionPoints: 3,
        partyLeaderId: undefined,
        zones: {
          hand: [],
          party: [],
          discardPile: []
        }
      };
    }
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    const wasLobbyLeader = socket.id === gameState.lobbyLeaderId;
    delete gameState.players[socket.id];

    if (gameState.activePlayerId === socket.id) {
      gameState.activePlayerId = Object.keys(gameState.players)[0] ?? '';
    }

    if (wasLobbyLeader) {
      gameState.lobbyLeaderId = Object.keys(gameState.players)[0] ?? undefined;
    }

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});