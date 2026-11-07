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
const rooms = new Map(); // roomId -> { game, playerIds: Set<socketId>, lastActivityAt }

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_NAME_LEN = 12;
const MAX_CHAT_LEN = 100;
const IDLE_ROOM_MS = 30 * 60 * 1000;

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_RE.test(roomId);
}

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return null;
  // 去掉控制字符并 trim
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean || clean.length > maxLen) return null;
  return clean;
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      game: new PokerGame(roomId),
      playerIds: new Set(), // socket ids
      lastActivityAt: Date.now()
    };
    rooms.set(roomId, room);
  }
  return room;
}

function touch(room) {
  room.lastActivityAt = Date.now();
}

function broadcastState(room) {
  for (const sid of room.playerIds) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('state', room.game.getPublicState(sock.data.playerId));
    }
  }
}

// 统一包装 socket handler：任何异常都不能打崩进程
function safeHandler(socket, fn) {
  return (payload) => {
    try {
      fn(payload);
    } catch (err) {
      console.error('[handler]', err);
      socket.emit('error', '服务器处理失败');
    }
  };
}

io.on('connection', (socket) => {
  socket.data = socket.data || {};

  socket.on('join', safeHandler(socket, (payload) => {
    if (!payload || typeof payload !== 'object') {
      socket.emit('error', '参数错误');
      return;
    }
    const { roomId, name } = payload;

    if (!isValidRoomId(roomId)) {
      socket.emit('error', '房间号只能是 1–20 位字母、数字、下划线或短横线');
      return;
    }
    const cleanName = sanitizeText(name, MAX_NAME_LEN);
    if (!cleanName) {
      socket.emit('error', '昵称需为 1–12 个字符');
      return;
    }

    // 一个 socket 同时只能属于一个房间：先清理旧房间
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      handleLeave(socket);
    }

    const room = getRoom(roomId);
    const playerId = socket.data.playerId && socket.data.roomId === roomId
      ? socket.data.playerId
      : 'p_' + socket.id;

    // join 幂等：已在本房间且已占座，直接重发状态
    if (socket.data.roomId === roomId && room.game.players.some(p => p.id === playerId)) {
      socket.join(roomId);
      socket.emit('joined', { playerId, roomId, reconnected: false });
      broadcastState(room);
      return;
    }

    // 牌局进行中禁止新玩家加入
    if (room.game.isHandInProgress()) {
      socket.emit('error', '本局进行中，请等待本局结束');
      return;
    }

    // 昵称去重（大小写不敏感 + trim）
    const lower = cleanName.toLowerCase();
    if (room.game.players.some(p => p.name.trim().toLowerCase() === lower)) {
      socket.emit('error', '该昵称已被使用');
      return;
    }

    socket.data.playerId = playerId;
    socket.data.roomId = roomId;
    socket.join(roomId);

    const player = room.game.addPlayer(playerId, cleanName, socket);
    if (!player) {
      socket.emit('error', '房间已满（最多 7 人）');
      return;
    }

    room.playerIds.add(socket.id);
    touch(room);

    socket.emit('joined', { playerId, roomId, reconnected: false });
    broadcastState(room);
    io.to(roomId).emit('chat', { system: true, text: `${cleanName} 加入了房间` });
  }));

  socket.on('start', safeHandler(socket, () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.game.startHand()) {
      touch(room);
      broadcastState(room);
    } else if (room.game.stage === 'waiting' || room.game.stage === 'ended') {
      socket.emit('error', '无法开始新一局：至少需要 2 名还有筹码的玩家');
    }
  }));

  socket.on('action', safeHandler(socket, (payload) => {
    if (!payload || typeof payload !== 'object') {
      socket.emit('error', '参数错误');
      return;
    }
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const playerId = socket.data.playerId;
    const { action, amount } = payload;

    if (room.game.playerAction(playerId, action, amount)) {
      touch(room);
      broadcastState(room);
    } else {
      socket.emit('error', '无效操作');
    }
  }));

  socket.on('chat', safeHandler(socket, (payload) => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    const player = room.game.players.find(p => p.id === socket.data.playerId);
    if (!player) return;
    const text = sanitizeText(payload, MAX_CHAT_LEN);
    if (!text) return;
    touch(room);
    io.to(roomId).emit('chat', { name: player.name, text });
  }));

  socket.on('leave', safeHandler(socket, () => {
    handleLeave(socket);
  }));

  socket.on('disconnect', safeHandler(socket, () => {
    handleLeave(socket);
  }));
});

function handleLeave(socket) {
  const roomId = socket.data.roomId;
  const playerId = socket.data.playerId;
  if (!roomId || !playerId) return;
  const room = rooms.get(roomId);
  if (!room) {
    socket.data.roomId = null;
    socket.data.playerId = null;
    return;
  }

  const player = room.game.players.find(p => p.id === playerId);
  if (player) {
    io.to(roomId).emit('chat', { system: true, text: `${player.name} 离开了房间` });

    if (room.game.isHandInProgress()) {
      // 牌局中：标记弃牌但保留座位，本局结束后移除
      room.game.markFolded(playerId);
    } else {
      room.game.removePlayer(playerId);
    }
    touch(room);
  }

  room.playerIds.delete(socket.id);

  // 清理后置空，避免后续 chat 命中已删除房间
  socket.data.roomId = null;
  socket.data.playerId = null;

  // 房间空了就销毁
  if (room.playerIds.size === 0) {
    rooms.delete(roomId);
    return;
  }
  broadcastState(room);
}

// 空闲房间定时清理
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const noSockets = room.playerIds.size === 0;
    if (noSockets && now - room.lastActivityAt > IDLE_ROOM_MS) {
      rooms.delete(roomId);
    }
  }
}, 60 * 1000).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`德州扑克服务器运行在 http://localhost:${PORT}`);
});
