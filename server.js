const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const PokerGame = require('./game/pokerGame');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// 房间管理
const rooms = {}; // roomId -> { game, players: Set<socketId> }

function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = {
      game: new PokerGame(roomId),
      playerIds: [] // socket ids in order
    };
  }
  return rooms[roomId];
}

function broadcastState(room) {
  for (const sid of room.playerIds) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('state', room.game.getPublicState(sock.data.playerId));
    }
  }
}

io.on('connection', (socket) => {
  socket.data = socket.data || {};

  socket.on('join', ({ roomId, name }) => {
    if (!roomId || !name) {
      socket.emit('error', '请输入房间号和昵称');
      return;
    }
    const room = getRoom(roomId);
    if (room.game.players.length >= 7) {
      socket.emit('error', '房间已满（最多 7 人）');
      return;
    }
    // 检查昵称重复
    if (room.game.players.some(p => p.name === name)) {
      socket.emit('error', '该昵称已被使用');
      return;
    }

    const playerId = 'p_' + socket.id;
    socket.data.playerId = playerId;
    socket.data.roomId = roomId;
    socket.join(roomId);

    const player = room.game.addPlayer(playerId, name, socket);
    room.playerIds.push(socket.id);

    socket.emit('joined', { playerId, roomId });
    broadcastState(room);
    io.to(roomId).emit('chat', { system: true, text: `${name} 加入了房间` });
  });

  socket.on('start', () => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    if (room.game.startHand()) {
      broadcastState(room);
    } else if (room.game.stage === 'waiting' || room.game.stage === 'ended') {
      socket.emit('error', '无法开始新一局：至少需要 2 名还有筹码的玩家');
    }
  });

  socket.on('action', ({ action, amount }) => {
    const roomId = socket.data.roomId;
    const room = rooms[roomId];
    if (!room) return;
    const playerId = socket.data.playerId;
    if (room.game.playerAction(playerId, action, amount)) {
      broadcastState(room);
    }
  });

  socket.on('chat', (text) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    const player = room.game.players.find(p => p.id === socket.data.playerId);
    if (player) {
      io.to(roomId).emit('chat', { name: player.name, text });
    }
  });

  socket.on('leave', () => {
    handleLeave(socket);
  });

  socket.on('disconnect', () => {
    handleLeave(socket);
  });
});

function handleLeave(socket) {
  const roomId = socket.data.roomId;
  const playerId = socket.data.playerId;
  if (!roomId || !rooms[roomId]) return;
  const room = rooms[roomId];
  const player = room.game.players.find(p => p.id === playerId);
  if (player) {
    io.to(roomId).emit('chat', { system: true, text: `${player.name} 离开了房间` });
    // 如果游戏进行中，标记为弃牌
    if (room.game.stage !== 'waiting' && room.game.stage !== 'ended') {
      player.folded = true;
      player.disconnected = true;
      // 如果是当前玩家回合，跳过
      if (room.game.players[room.game.currentPlayerIndex]?.id === playerId) {
        // 触发检查
        room.game.checkRoundEnd();
      }
    }
    room.game.removePlayer(playerId);
  }
  room.playerIds = room.playerIds.filter(id => id !== socket.id);

  // 房间空了就销毁
  if (room.playerIds.length === 0) {
    delete rooms[roomId];
    return;
  }
  broadcastState(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`德州扑克服务器运行在 http://localhost:${PORT}`);
});
