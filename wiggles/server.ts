import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

import type { ClientToServerEvents, ServerToClientEvents, GameState, Player } from '../shared/types.js'

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
  stack: []
};

io.on('connection', (socket: Socket) => {
  console.log(`Player connected: ${socket.id}`);
  gameState.players[socket.id] = {
    id: socket.id,
    zones: {
      hand: [],
      party: []
    }
  };

  if (!gameState.activePlayerId) {
    gameState.activePlayerId = socket.id;
  }

  io.emit('playersUpdated', Object.values(gameState.players));

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