const express = require('express');
const http = require('http');
const crypto = require('crypto');
const webpush = require('web-push');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 8 * 1024 * 1024 // 8 Mo, pour laisser passer photos/notes vocales
});

app.use(express.json({ limit: '8mb' }));
app.use(express.static('public'));

// --- Cles VAPID (regenerees a chaque redemarrage du serveur) ---
const vapidKeys = webpush.generateVAPIDKeys();
webpush.setVapidDetails('mailto:duochat@example.com', vapidKeys.publicKey, vapidKeys.privateKey);

app.get('/vapid-public-key', (req, res) => {
  res.json({ publicKey: vapidKeys.publicKey });
});

// --- Etat en memoire ---
// rooms[code] = { messages: [], game: {cells, turn, active}, subscriptions: { deviceId: sub } }
const rooms = {};
const MAX_MESSAGES = 300;

function getRoom(code) {
  if (!rooms[code]) {
    rooms[code] = {
      messages: [],
      game: { cells: Array(9).fill(''), turn: 'X', active: false },
      subscriptions: {}
    };
  }
  return rooms[code];
}

function checkWinner(c) {
  const lines = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  for (const [a,b,cc] of lines) if (c[a] && c[a] === c[b] && c[a] === c[cc]) return c[a];
  return null;
}

function notifyRoom(code, excludeDeviceId, payload) {
  const room = getRoom(code);
  Object.entries(room.subscriptions).forEach(([deviceId, sub]) => {
    if (deviceId === excludeDeviceId) return;
    webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => {
      // abonnement invalide (serveur redemarre, permission revoquee...) : on l'oublie
      delete room.subscriptions[deviceId];
    });
  });
}

io.on('connection', (socket) => {
  let joinedCode = null;
  let myDeviceId = null;
  let myName = null;

  socket.on('join_room', ({ code, name, deviceId }) => {
    if (!code || !name || !deviceId) return;
    joinedCode = String(code).trim().toUpperCase();
    myDeviceId = deviceId;
    myName = String(name).slice(0, 20);
    socket.join(joinedCode);
    const room = getRoom(joinedCode);
    socket.emit('room_init', { messages: room.messages, game: room.game });
    socket.to(joinedCode).emit('peer_status', { name: myName, online: true });
  });

  socket.on('send_message', (msg) => {
    if (!joinedCode || !msg) return;
    const room = getRoom(joinedCode);
    const clean = {
      id: crypto.randomUUID(),
      sender: myName,
      deviceId: myDeviceId,
      type: msg.type === 'image' || msg.type === 'audio' ? msg.type : 'text',
      content: String(msg.content || '').slice(0, 6 * 1024 * 1024),
      ts: Date.now()
    };
    room.messages.push(clean);
    if (room.messages.length > MAX_MESSAGES) room.messages = room.messages.slice(-MAX_MESSAGES);
    io.to(joinedCode).emit('new_message', clean);
    const preview = clean.type === 'text' ? clean.content.slice(0, 80) : (clean.type === 'image' ? 'Photo' : 'Note vocale');
    notifyRoom(joinedCode, myDeviceId, { title: myName, body: preview });
  });

  socket.on('delete_message', ({ messageId }) => {
    if (!joinedCode || !messageId) return;
    const room = getRoom(joinedCode);
    room.messages = room.messages.filter(m => m.id !== messageId);
    io.to(joinedCode).emit('message_deleted', { messageId });
  });

  socket.on('game_invite', () => {
    if (!joinedCode) return;
    socket.to(joinedCode).emit('game_invite', { from: myName });
  });

  socket.on('game_accept', () => {
    if (!joinedCode) return;
    const room = getRoom(joinedCode);
    room.game = { cells: Array(9).fill(''), turn: 'X', active: true };
    io.to(joinedCode).emit('game_started', room.game);
  });

  socket.on('game_decline', () => {
    if (!joinedCode) return;
    socket.to(joinedCode).emit('game_declined');
  });

  socket.on('play_move', ({ index }) => {
    if (!joinedCode || typeof index !== 'number') return;
    const room = getRoom(joinedCode);
    if (index < 0 || index > 8) return;
    if (room.game.cells[index] || checkWinner(room.game.cells)) return;
    room.game.cells[index] = room.game.turn;
    room.game.turn = room.game.turn === 'X' ? 'O' : 'X';
    io.to(joinedCode).emit('game_update', room.game);
  });

  socket.on('reset_game', () => {
    if (!joinedCode) return;
    const room = getRoom(joinedCode);
    room.game = { cells: Array(9).fill(''), turn: 'X', active: true };
    io.to(joinedCode).emit('game_update', room.game);
  });

  socket.on('subscribe_push', ({ subscription }) => {
    if (!joinedCode || !myDeviceId || !subscription) return;
    const room = getRoom(joinedCode);
    room.subscriptions[myDeviceId] = subscription;
  });

  socket.on('disconnect', () => {
    if (joinedCode && myName) {
      socket.to(joinedCode).emit('peer_status', { name: myName, online: false });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('DuoChat server running on port ' + PORT));
