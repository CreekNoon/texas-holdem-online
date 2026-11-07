const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const PokerGame = require('./game/pokerGame');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// 房间管理
const rooms = new Map(); // roomId -> { game, playerIds: Set<socketId>, lastActivityAt, turnTimer, graceTimers }

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,20}$/;
const MAX_NAME_LEN = 12;
const MAX_CHAT_LEN = 100;
const IDLE_ROOM_MS = 30 * 60 * 1000;

// 可注入的时长，便于测试（PRD-02 §6）
const TURN_TIME_MS = Number(process.env.TURN_TIME_MS) || 30000;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 120000;

function isValidRoomId(roomId) {
  return typeof roomId === 'string' && ROOM_ID_RE.test(roomId);
}

function sanitizeText(value, maxLen) {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!clean || clean.length > maxLen) return null;
  return clean;
}

function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      game: new PokerGame(roomId, { turnTimeMs: TURN_TIME_MS }),
      playerIds: new Set(),
      lastActivityAt: Date.now(),
      turnTimer: null,
      turnTimerSeq: -1,
      graceTimers: new Map() // playerId -> timeout
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

// ===== 回合超时（PRD-02 §4.1）=====

function clearTurnTimer(room) {
  if (room.turnTimer) {
    clearTimeout(room.turnTimer);
    room.turnTimer = null;
  }
  room.turnTimerSeq = -1;
  room.game.turnDeadline = null;
}

// 只在“回合切换”时重新 arm，避免 join/chat 替当前玩家续时
function armTurnTimer(room) {
  const game = room.game;
  if (!game.isTurnActive()) {
    clearTurnTimer(room);
    return;
  }

  // turnSeq 未变 → 同一回合，不重置
  if (room.turnTimer && room.turnTimerSeq === game.turnSeq) return;

  clearTurnTimer(room);

  const current = game.players[game.currentPlayerIndex];
  game.turnDeadline = Date.now() + game.turnTimeMs;
  room.turnTimerSeq = game.turnSeq;

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    room.turnTimerSeq = -1;
    game.turnDeadline = null;
    onTurnTimeout(room, current.id);
  }, game.turnTimeMs);
}

function onTurnTimeout(room, playerId) {
  const game = room.game;
  // 超时前玩家可能已重连/已弃牌/已换人，重新校验
  const current = game.players[game.currentPlayerIndex];
  if (!current || current.id !== playerId) return;
  if (!game.isTurnActive()) return;

  const callAmount = Math.max(0, game.currentBet - current.currentBet);
  const action = callAmount === 0 ? 'check' : 'fold';
  const ok = game.playerAction(playerId, action, 0);

  if (ok) {
    game.addLog(`${current.name} 行动超时，自动${action === 'check' ? '过牌' : '弃牌'}`);
  } else {
    game.addLog(`${current.name} 行动超时，自动动作失败`);
  }

  touch(room);
  armTurnTimer(room); // 先 arm，再广播
  broadcastState(room);
}

// ===== 断线宽限期（PRD-02 §3.3）=====

function clearGraceTimer(room, playerId) {
  const timer = room.graceTimers.get(playerId);
  if (timer) {
    clearTimeout(timer);
    room.graceTimers.delete(playerId);
  }
}

function armGraceTimer(room, playerId) {
  clearGraceTimer(room, playerId);
  const timer = setTimeout(() => {
    room.graceTimers.delete(playerId);
    const game = room.game;
    const player = game.players.find(p => p.id === playerId);
    if (!player || !player.disconnected) return;

    if (game.isHandInProgress()) {
      // 宽限期结束：此时才真正弃牌，座位仍保留到本局结束
      game.foldDisconnectedPlayer(playerId);
    } else {
      // waiting/ended：直接移除
      game.removePlayer(playerId);
      room.playerIds.delete(player.socketId || '');
    }

    touch(room);
    armTurnTimer(room);
    broadcastState(room);
  }, RECONNECT_GRACE_MS);

  room.graceTimers.set(playerId, timer);
}

// ===== 事件处理 =====

io.on('connection', (socket) => {
  socket.data = socket.data || {};

  socket.on('join', safeHandler(socket, (payload) => {
    if (!payload || typeof payload !== 'object') {
      socket.emit('error', '参数错误');
      return;
    }
    const { roomId, name, playerId, token } = payload;

    if (!isValidRoomId(roomId)) {
      socket.emit('error', '房间号只能是 1–20 位字母、数字、下划线或短横线');
      return;
    }

    // 一个 socket 同时只能属于一个房间：先清理旧房间
    if (socket.data.roomId && socket.data.roomId !== roomId) {
      handleLeave(socket);
    }

    const room = getRoom(roomId);

    // ===== 重连路径：携带 playerId + token =====
    if (playerId) {
      const existing = room.game.players.find(p => p.id === playerId);
      if (!existing) {
        socket.emit('error', '重连失败：座位已不存在');
        return;
      }

      if (!room.game.findPlayerByToken(playerId, token)) {
        socket.emit('error', '重连凭证无效');
        return;
      }

      // 仍在线 → 踢掉旧 socket
      if (!existing.disconnected && existing.socketId && existing.socketId !== socket.id) {
        const oldSock = io.sockets.sockets.get(existing.socketId);
        if (oldSock) {
          oldSock.emit('session:replaced', { message: '账号在其他窗口登录' });
          oldSock.disconnect(true);
        }
      }

      // 恢复绑定
      clearGraceTimer(room, playerId);
      room.game.setPlayerConnection(playerId, socket.id, true);
      socket.data.playerId = playerId;
      socket.data.roomId = roomId;
      socket.join(roomId);
      room.playerIds.add(socket.id);
      touch(room);

      // token 轮换：旧 token 立即失效
      const newToken = room.game.rotateToken(playerId);

      socket.emit('joined', {
        playerId,
        token: newToken,
        roomId,
        name: existing.name,
        reconnected: true
      });
      armTurnTimer(room);
      broadcastState(room);
      return;
    }

    // ===== 新建玩家路径 =====
    const cleanName = sanitizeText(name, MAX_NAME_LEN);
    if (!cleanName) {
      socket.emit('error', '昵称需为 1–12 个字符');
      return;
    }

    // join 幂等：已在本房间且已占座，直接重发状态
    if (socket.data.roomId === roomId && socket.data.playerId &&
        room.game.players.some(p => p.id === socket.data.playerId)) {
      socket.join(roomId);
      socket.emit('joined', { playerId: socket.data.playerId, roomId, reconnected: false });
      broadcastState(room);
      return;
    }

    if (room.game.isHandInProgress()) {
      socket.emit('error', '本局进行中，请等待本局结束');
      return;
    }

    const lower = cleanName.toLowerCase();
    if (room.game.players.some(p => p.name.trim().toLowerCase() === lower)) {
      socket.emit('error', '该昵称已被使用');
      return;
    }

    const newId = 'p_' + crypto.randomUUID();
    const player = room.game.addPlayer(newId, cleanName, { id: socket.id });
    if (!player) {
      socket.emit('error', '房间已满（最多 7 人）');
      return;
    }

    socket.data.playerId = newId;
    socket.data.roomId = roomId;
    socket.join(roomId);
    room.playerIds.add(socket.id);
    touch(room);

    socket.emit('joined', {
      playerId: newId,
      token: player.token,
      roomId,
      name: cleanName,
      reconnected: false
    });
    broadcastState(room);
    io.to(roomId).emit('chat', { system: true, text: `${cleanName} 加入了房间` });
  }));

  socket.on('start', safeHandler(socket, () => {
    const roomId = socket.data.roomId;
    const room = rooms.get(roomId);
    if (!room) return;
    if (room.game.startHand()) {
      touch(room);
      armTurnTimer(room); // 先 arm，再广播，保证 state 里带 turnDeadline
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
      clearTurnTimer(room);
      armTurnTimer(room); // 先 arm，再广播
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
    handleDisconnect(socket);
  }));
});

// 显式离开：立即弃牌 + 立即移除（不进入宽限期）
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
    // 会话已被新连接接管时，旧 socket 的 leave 不应把玩家踢下桌
    if (player.socketId && player.socketId !== socket.id) {
      room.playerIds.delete(socket.id);
      socket.data.roomId = null;
      socket.data.playerId = null;
      return;
    }

    io.to(roomId).emit('chat', { system: true, text: `${player.name} 离开了房间` });
    clearGraceTimer(room, playerId);

    if (room.game.isHandInProgress()) {
      room.game.markFolded(playerId);
    } else {
      room.game.removePlayer(playerId);
    }
    touch(room);
  }

  room.playerIds.delete(socket.id);
  socket.data.roomId = null;
  socket.data.playerId = null;

  if (room.playerIds.size === 0 && room.game.players.length === 0) {
    clearTurnTimer(room);
    rooms.delete(roomId);
    return;
  }
  armTurnTimer(room);
  broadcastState(room);
}

// 断线：保留座位 + 宽限期，不立即弃牌（PRD-02 §3.3）
function handleDisconnect(socket) {
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
    // 关键防护：如果该玩家的 socketId 已经指向别的连接（会话被接管），
    // 这个 disconnect 属于旧 socket，不能把新连接标记为离线。
    if (player.socketId && player.socketId !== socket.id) {
      room.playerIds.delete(socket.id);
      return;
    }

    room.game.markDisconnected(playerId);
    room.playerIds.delete(socket.id);
    touch(room);
    armGraceTimer(room, playerId);
    // 掉线玩家不计时：armTurnTimer 会因 isTurnActive() 为 false 而清除计时器
    armTurnTimer(room);
    broadcastState(room);
  }

  socket.data.roomId = null;
  socket.data.playerId = null;
}

// 空闲房间定时清理
setInterval(() => {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    const noSockets = room.playerIds.size === 0;
    if (noSockets && now - room.lastActivityAt > IDLE_ROOM_MS) {
      clearTurnTimer(room);
      for (const t of room.graceTimers.values()) clearTimeout(t);
      room.graceTimers.clear();
      rooms.delete(roomId);
    }
  }
}, 60 * 1000).unref();

// 测试/关闭时清理所有计时器
function shutdown() {
  for (const room of rooms.values()) {
    clearTurnTimer(room);
    for (const t of room.graceTimers.values()) clearTimeout(t);
    room.graceTimers.clear();
  }
  rooms.clear();
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`德州扑克服务器运行在 http://localhost:${PORT}`);
});

module.exports = { server, io, shutdown, rooms };
