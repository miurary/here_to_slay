import express from 'express';
import { createServer } from 'http';
import { Server, Socket } from 'socket.io';
import cors from 'cors';

// Define what the server receives from the client
interface ClientToServerEvents {
  pingServer: () => void;
  // Later you'll add things like: 
  // playCard: (payload: { cardInstanceId: string }) => void;
}

// Define what the server sends to the client
interface ServerToClientEvents {
  pongClient: (data: { message: string }) => void;
  // Later: 
  // stateUpdate: (state: GameState) => void;
}

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

io.on('connection', (socket: Socket) => {
  console.log(`Player connected: ${socket.id}`);

  // TypeScript knows 'pingServer' is a valid event!
  socket.on('pingServer', () => {
    console.log(`Ping received from ${socket.id}`);
    
    // TypeScript forces you to send an object with a 'message' string
    socket.emit('pongClient', { message: "Connection successful!" });
  });

  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

const PORT = 3001;
httpServer.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});