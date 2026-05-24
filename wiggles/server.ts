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

type CardTemplate = { id: string; type: string; [key: string]: any };

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
  diceRolls: {}
};

io.on('connection', (socket: Socket) => {
  console.log(`Player connected: ${socket.id}`);
  gameState.players[socket.id] = {
    id: socket.id,
    username: undefined,
    actionPoints: 3,
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
      const cards = drawCards(gameState.mainDeck, 5);
      player.zones.hand.push(...cards);
    }

    // Transition to rolling phase and set first roller
    gameState.status = 'rolling';
    gameState.diceRolls = {};
    gameState.currentRollerId = playerIds[0];
    gameState.turnNumber = 0;

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

    // Move to next roller
    const playerIds = Object.keys(gameState.players);
    const rolledPlayerIds = Object.keys(gameState.diceRolls);
    const nextRollerIndex = playerIds.findIndex(id => !rolledPlayerIds.includes(id));

    if (nextRollerIndex >= 0) {
      // There are more players to roll
      gameState.currentRollerId = playerIds[nextRollerIndex];
    } else {
      // All players have rolled - determine winner
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
      gameState.turnNumber = 1;
      gameState.phase = 'DRAW';
      gameState.status = 'in_progress';
      gameState.diceRolls = {};
    }

    io.emit('stateUpdate', gameState);
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('quitGame', () => {
    if (gameState.status !== 'in_progress') {
      return;
    }

    // Reset game state back to waiting
    gameState.status = 'waiting';
    gameState.turnNumber = 0;
    gameState.phase = 'DRAW';
    gameState.activePlayerId = Object.keys(gameState.players)[0] || '';
    gameState.firstPlayerId = undefined;
    gameState.monsterDeck = [];
    gameState.partyLeaderDeck = [];
    gameState.mainDeck = [];
    gameState.activeMonsters = [];
    gameState.discardedMonsters = [];
    gameState.discardPile = [];
    gameState.stack = [];

    // Reset player hands and zones
    for (const playerId of Object.keys(gameState.players)) {
      const player = gameState.players[playerId];
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
        zones: {
          hand: [],
          party: []
        }
      };
    }
    io.emit('playersUpdated', Object.values(gameState.players));
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);

    delete gameState.players[socket.id];

    if (gameState.activePlayerId === socket.id) {
      gameState.activePlayerId = Object.keys(gameState.players)[0] ?? '';
    }

    io.emit('playersUpdated', Object.values(gameState.players));
  });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});