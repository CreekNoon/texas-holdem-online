const express = require('express');
const http = require('http');
const path = require('path');
const crypto = require('node:crypto');
const { Server } = require('socket.io');
const PokerGame = require('./game/pokerGame');
const { BotScheduler } = require('./game/botScheduler');
const { equity } = require('./game/equity');
const { Tournament } = require('./game/tournament');

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
const MAX_PLAYERS = 7;
const IDLE_ROOM_MS = 30 * 60 * 1000;

// 可注入的时长，便于测试（PRD-02 §6 / PRD-03）
const TURN_TIME_MS = Number(process.env.TURN_TIME_MS) || 30000;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 120000;
const BOT_MIN_DELAY_MS = Number(process.env.BOT_MIN_DELAY_MS) || 600;
const BOT_MAX_DELAY_MS = Number(process.env.BOT_MAX_DELAY_MS) || 1400;
const EQUITY_ITERATIONS = Number(process.env.EQUITY_ITERATIONS) || 3000;

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
    const game = new PokerGame(roomId, { turnTimeMs: TURN_TIME_MS });
    room = {
      game,
      playerIds: new Set(),
      lastActivityAt: Date.now(),
      turnTimer: null,
      turnTimerSeq: -1,
      graceTimers: new Map(), // playerId -> timeout
      botScheduler: null,
      hostId: null,
      spectators: new Set(), // socketId 集合，不占座位
      spectatorSeeAll: false,
      config: {
        mode: 'cash',
        fillWithBots: false,
        botCount: 3,
        botDifficulty: 'normal',
        // 默认不强制准备，避免破坏既有"点开始就开局"的用法；
        // 房主可在大厅显式开启（PRD-04 §3.2）
        requireReady: false
      },
      // SNG 锦标赛（PRD-05）：cash 模式下为 null
      tournament: null,
      levelTimer: null
    };
    room.botScheduler = new BotScheduler(game, {
      minDelay: BOT_MIN_DELAY_MS,
      maxDelay: BOT_MAX_DELAY_MS,
      onAction: () => {
        // 机器人行动后继续走统一状态变更流程（会再次 tick，调度下一个 bot）
        touch(room);
        afterStateChange(room);
        // SNG：机器人行动也可能结束本手
        if (room.tournament && room.tournament.state === 'running' && room.game.stage === 'ended') {
          onTournamentHandEnded(room);
        }
      }
    });
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
      sock.emit('state', buildRoomState(room, sock.data.playerId));
    }
  }
  // 观战者：不占座位，单独下发（默认看不到底牌）
  for (const sid of room.spectators) {
    const sock = io.sockets.sockets.get(sid);
    if (sock) {
      sock.emit('state', buildRoomState(room, null, true));
    }
  }
}

// 组装下发给客户端的完整房间状态（PRD-04 §3.2/§3.3）
function buildRoomState(room, selfId, isSpectator = false) {
  const state = room.game.getPublicState(selfId);

  // 观战者：默认看不到任何底牌；房主显式开启 spectatorSeeAll 后才公开
  if (isSpectator) {
    for (const p of state.players) {
      const isShownAtShowdown = state.result && state.result.players
        && state.result.players.find(x => x.id === p.id && x.shown);
      p.hand = (room.spectatorSeeAll && isShownAtShowdown) ? p.hand : [];
    }
    state.winners = state.winners.map(w => ({ ...w, hand: room.spectatorSeeAll ? w.hand : null }));
  }

  state.hostId = room.hostId;
  state.isHost = !!selfId && room.hostId === selfId;
  state.spectator = isSpectator;
  state.spectatorSeeAll = !!room.spectatorSeeAll;
  state.spectatorCount = room.spectators.size;
  state.requireReady = room.config.requireReady;
  state.readyIds = room.game.players.filter(p => p.ready).map(p => p.id);
  state.config = {
    mode: room.config.mode,
    botCount: room.config.botCount,
    botDifficulty: room.config.botDifficulty
  };

  // SNG 锦标赛快照（PRD-05 §5.1）
  state.tournament = room.tournament ? room.tournament.toPublicState() : null;

  return state;
}

// ===== SNG 锦标赛辅助（PRD-05）=====

const LEVEL_TIMER_MS = Number(process.env.LEVEL_TIMER_MS) || 0; // 0 = 用 blindSchedule 的 durationMs

function clearLevelTimer(room) {
  if (room.levelTimer) {
    clearTimeout(room.levelTimer);
    room.levelTimer = null;
  }
}

// 把锦标赛当前盲注/前注应用到 PokerGame
function applyTournamentBlinds(room) {
  const t = room.tournament;
  if (!t) return;
  const { sb, bb, ante } = t.blinds;
  room.game.smallBlind = sb;
  room.game.bigBlind = bb;
  room.game.ante = ante;
}

// 安排下一次盲注升级（§4.2）
function armLevelTimer(room) {
  clearLevelTimer(room);
  const t = room.tournament;
  if (!t || t.state !== 'running') return;
  if (t.levelEndsAt === null) return;
  if (t.levelIndex >= t.blindSchedule.length - 1) return;

  const delay = Math.max(0, t.levelEndsAt - Date.now());
  room.levelTimer = setTimeout(() => {
    room.levelTimer = null;
    if (!room.tournament || room.tournament.state !== 'running') return;

    const inProgress = room.game.isHandInProgress();
    const change = room.tournament.tickLevel(Date.now(), inProgress);

    if (change && !change.pending) {
      applyTournamentBlinds(room);
      io.to(room.tournament.id ? findRoomId(room) : '').emit('tournament:level', {
        ...room.tournament.toPublicState(),
        level: change.level
      });
      armLevelTimer(room);
      afterStateChange(room);
    } else if (change && change.pending) {
      // 本手结束后由 onHandEnded 应用
      broadcastState(room);
    }
  }, delay);

  if (room.levelTimer.unref) room.levelTimer.unref();
}

function findRoomId(room) {
  for (const [id, r] of rooms) if (r === room) return id;
  return '';
}

// 开始一手锦标赛牌局
function startTournamentHand(room) {
  const t = room.tournament;
  if (!t || t.state !== 'running') return false;

  // 淘汰者不参与下一手
  for (const e of t.entrants) {
    if (e.eliminated) {
      const p = room.game.players.find(x => x.id === e.playerId);
      // 锦标赛淘汰：筹码已归 0，不应计入 withdrawnChips
      if (p) room.game.removePlayer(p.id, { noWithdraw: true });
    }
  }

  applyTournamentBlinds(room);
  t.beginHand(room.game.players);

  const ok = room.game.startHand();
  if (!ok) return false;

  armLevelTimer(room);
  return true;
}

// 每手结束后的锦标赛处理：淘汰 → 名次 → 升级 → 下一手或结束
function onTournamentHandEnded(room) {
  const t = room.tournament;
  if (!t || t.state !== 'running') return;

  t.syncChips(room.game.players);
  const result = t.onHandFinished(Date.now());

  const roomId = findRoomId(room);

  // 广播淘汰
  for (const e of (result && result.eliminated) || []) {
    io.to(roomId).emit('tournament:eliminated', e);
    room.game.addLog(`${e.name} 被淘汰，第 ${e.place} 名`);
  }

  // 升级（若挂起）
  if (result && result.levelChange) {
    applyTournamentBlinds(room);
    io.to(roomId).emit('tournament:level', {
      ...t.toPublicState(),
      level: result.levelChange.level
    });
    armLevelTimer(room);
  }

  if (t.state === 'finished') {
    clearLevelTimer(room);
    // 锦标赛结束后也要清掉淘汰者座位，避免残留在最终状态里
    for (const e of t.entrants) {
      if (e.eliminated) {
        const p = room.game.players.find(x => x.id === e.playerId);
        if (p) room.game.removePlayer(p.id, { noWithdraw: true });
      }
    }
    io.to(roomId).emit('tournament:finished', t.toPublicState());
    broadcastState(room);
    return;
  }

  // 自动开下一手
  if (t.aliveEntrants().length >= 2) {
    startTournamentHand(room);
  }
  broadcastState(room);
}

// 统一包装 socket handler：任何异常都不能打崩进程
function safeHandler(socket, fn) {  return (payload) => {
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

// 每次状态变化后统一调用：先驱动机器人，再刷新计时器与广播
function afterStateChange(room) {
  if (room.botScheduler) room.botScheduler.tick();
  armTurnTimer(room);
  broadcastState(room);
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
  afterStateChange(room);
  // SNG：超时行动也可能结束本手
  if (room.tournament && room.tournament.state === 'running' && game.stage === 'ended') {
    onTournamentHandEnded(room);
  }
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
    afterStateChange(room);
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
    const { roomId, name, playerId, token, spectate } = payload;

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
      afterStateChange(room);
      return;
    }

    // ===== 新建玩家路径 =====
    // 观战：不占座位，走独立列表（PRD-04 §3.3）
    if (spectate) {
      const spectatorName = sanitizeText(name, MAX_NAME_LEN) || '观众';
      socket.data.roomId = roomId;
      socket.data.playerId = null;
      socket.data.spectating = true;
      socket.join(roomId);
      room.spectators.add(socket.id);
      touch(room);
      socket.emit('joined', { roomId, spectator: true, name: spectatorName, reconnected: false });
      broadcastState(room);
      io.to(roomId).emit('chat', { system: true, text: `${spectatorName} 以观战身份加入` });
      return;
    }

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

    // 首个加入者成为房主（PRD-04 §3.2）
    if (!room.hostId) room.hostId = newId;

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
    if (socket.data.spectating) {
      socket.emit('error', '观战者不能开始游戏');
      return;
    }

    // SNG 模式下由锦标赛自动控制牌局，不允许手动开始（PRD-05）
    if (room.tournament) {
      socket.emit('error', '锦标赛模式由系统自动开局');
      return;
    }

    // 房主校验（PRD-04 §3.2）
    if (room.hostId && room.hostId !== socket.data.playerId) {
      socket.emit('error', '等待房主开始');
      return;
    }

    // 准备校验：所有在线真人必须 ready（房主可关闭）
    if (room.config.requireReady) {
      const notReady = room.game.players.filter(
        p => !p.isBot && !p.disconnected && !p.ready
      );
      if (notReady.length > 0) {
        socket.emit('error', `还有玩家未准备：${notReady.map(p => p.name).join('、')}`);
        return;
      }
    }

    if (room.game.startHand()) {
      touch(room);
      afterStateChange(room);
    } else if (room.game.stage === 'waiting' || room.game.stage === 'ended') {
      socket.emit('error', '无法开始新一局：至少需要 2 名还有筹码的玩家');
    }
  }));

  // ===== 准备状态（PRD-04 §3.2）=====
  socket.on('ready', safeHandler(socket, (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (socket.data.spectating) return;

    const player = room.game.players.find(p => p.id === socket.data.playerId);
    if (!player) return;

    const wantReady = payload && typeof payload.ready === 'boolean' ? payload.ready : !player.ready;
    player.ready = wantReady;
    touch(room);
    broadcastState(room);
  }));

  // ===== 房主配置（PRD-04 §3.2）=====
  socket.on('host:config', safeHandler(socket, (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (socket.data.spectating) return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('error', '只有房主可以修改配置');
      return;
    }
    // 牌局进行中禁止改配置（会破坏 pot == Σ totalBet）
    if (room.game.isHandInProgress()) {
      socket.emit('error', '牌局进行中无法修改配置');
      return;
    }

    const { requireReady, spectatorSeeAll, smallBlind, bigBlind, startingChips } = payload;

    if (requireReady !== undefined) room.config.requireReady = !!requireReady;
    if (spectatorSeeAll !== undefined) room.spectatorSeeAll = !!spectatorSeeAll;

    if (smallBlind !== undefined || bigBlind !== undefined || startingChips !== undefined) {
      const sb = Number.isInteger(smallBlind) ? smallBlind : room.game.smallBlind;
      const bb = Number.isInteger(bigBlind) ? bigBlind : room.game.bigBlind;
      const chips = Number.isInteger(startingChips) ? startingChips : room.game.startingChips;

      if (sb < 1 || bb < sb || chips < bb * 2) {
        socket.emit('error', '盲注/筹码配置不合法');
        return;
      }
      room.game.smallBlind = sb;
      room.game.bigBlind = bb;
      room.game.startingChips = chips;
    }

    touch(room);
    broadcastState(room);
  }));

  // ===== SNG 锦标赛（PRD-05）=====

  // 创建 / 配置锦标赛（报名阶段）
  socket.on('tournament:create', safeHandler(socket, (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (socket.data.spectating) return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('error', '只有房主可以创建锦标赛');
      return;
    }
    if (room.tournament && room.tournament.state !== 'finished') {
      socket.emit('error', '锦标赛已在进行中');
      return;
    }
    if (room.game.isHandInProgress()) {
      socket.emit('error', '牌局进行中无法创建锦标赛');
      return;
    }

    const { buyIn, startingChips, maxPlayers, name } = payload;
    if (buyIn !== undefined && (!Number.isInteger(buyIn) || buyIn < 1)) {
      socket.emit('error', '买入必须为正整数');
      return;
    }
    if (startingChips !== undefined && (!Number.isInteger(startingChips) || startingChips < 20)) {
      socket.emit('error', '起始筹码必须 ≥ 20');
      return;
    }
    if (maxPlayers !== undefined && (!Number.isInteger(maxPlayers) || maxPlayers < 2 || maxPlayers > 7)) {
      socket.emit('error', '人数上限必须是 2–7');
      return;
    }

    room.config.mode = 'sng';
    room.tournament = new Tournament({
      id: `${socket.data.roomId}-${Date.now()}`,
      name: typeof name === 'string' ? name.slice(0, 20) : 'SNG 单桌赛',
      buyIn,
      startingChips,
      maxPlayers,
      // 测试注入：LEVEL_DURATION_MS 覆盖默认 5 分钟
      levelDurationMs: LEVEL_TIMER_MS || undefined
    });

    // 已在房间的玩家自动报名
    for (const p of room.game.players) {
      room.tournament.register(p.id, p.name);
    }

    touch(room);
    io.to(socket.data.roomId).emit('tournament:created', room.tournament.toPublicState());
    broadcastState(room);
  }));

  // 报名 / 取消报名
  socket.on('tournament:register', safeHandler(socket, (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.tournament) return;
    if (socket.data.spectating) return;

    const t = room.tournament;
    const player = room.game.players.find(p => p.id === socket.data.playerId);
    if (!player) return;

    const wantJoin = payload && typeof payload.join === 'boolean' ? payload.join : true;
    if (wantJoin) {
      if (!t.register(player.id, player.name)) {
        socket.emit('error', '无法报名（可能已满员或已开赛）');
        return;
      }
    } else {
      if (!t.unregister(player.id)) {
        socket.emit('error', '无法取消报名（可能已开赛）');
        return;
      }
    }
    touch(room);
    broadcastState(room);
  }));

  // 开始锦标赛
  socket.on('tournament:start', safeHandler(socket, () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.tournament) {
      socket.emit('error', '尚未创建锦标赛');
      return;
    }
    if (socket.data.spectating) {
      socket.emit('error', '观战者不能开始锦标赛');
      return;
    }
    if (room.hostId !== socket.data.playerId) {
      socket.emit('error', '只有房主可以开始锦标赛');
      return;
    }

    const t = room.tournament;
    if (!t.start()) {
      socket.emit('error', '至少需要 2 名选手才能开始');
      return;
    }

    // 应用起始筹码与盲注
    room.game.resetChips(t.startingChips);
    applyTournamentBlinds(room);

    // 只保留报名选手
    for (const p of [...room.game.players]) {
      if (!t.entrants.some(e => e.playerId === p.id)) {
        room.game.removePlayer(p.id);
      }
    }

    room.game.stage = 'ended'; // 允许 startHand
    startTournamentHand(room);

    io.to(socket.data.roomId).emit('tournament:started', t.toPublicState());
    touch(room);
    afterStateChange(room);
  }));

  // 再来一局：按同配置重建
  socket.on('tournament:rematch', safeHandler(socket, () => {
    const room = rooms.get(socket.data.roomId);
    if (!room || !room.tournament) return;
    if (room.hostId !== socket.data.playerId) {
      socket.emit('error', '只有房主可以重开');
      return;
    }
    const old = room.tournament;
    if (old.state !== 'finished') {
      socket.emit('error', '锦标赛尚未结束');
      return;
    }

    clearLevelTimer(room);
    room.tournament = new Tournament({
      id: `${socket.data.roomId}-${Date.now()}`,
      name: old.name,
      buyIn: old.buyIn,
      startingChips: old.startingChips,
      maxPlayers: old.maxPlayers
    });
    for (const p of room.game.players) {
      room.tournament.register(p.id, p.name);
    }

    touch(room);
    io.to(socket.data.roomId).emit('tournament:created', room.tournament.toPublicState());
    broadcastState(room);
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
      afterStateChange(room);
      // SNG：每手结束后处理淘汰/升级/自动开下一手
      if (room.tournament && room.tournament.state === 'running' && room.game.stage === 'ended') {
        onTournamentHandEnded(room);
      }
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

  // ===== 训练模式：房间配置（PRD-03 §4.3）=====
  socket.on('room:configure', safeHandler(socket, (payload) => {
    if (!payload || typeof payload !== 'object') {
      socket.emit('error', '参数错误');
      return;
    }
    const room = rooms.get(socket.data.roomId);
    if (!room) return;

    const { mode, fillWithBots, botCount, botDifficulty } = payload;

    if (mode !== undefined) {
      if (!['cash', 'training'].includes(mode)) {
        socket.emit('error', '未知房间模式');
        return;
      }
      room.config.mode = mode;
    }
    if (fillWithBots !== undefined) room.config.fillWithBots = !!fillWithBots;
    if (botCount !== undefined) {
      if (!Number.isInteger(botCount) || botCount < 0 || botCount > 6) {
        socket.emit('error', 'botCount 必须是 0–6 的整数');
        return;
      }
      room.config.botCount = botCount;
    }
    if (botDifficulty !== undefined) {
      if (!['easy', 'normal', 'hard'].includes(botDifficulty)) {
        socket.emit('error', '未知难度');
        return;
      }
      room.config.botDifficulty = botDifficulty;
    }

    // 训练模式默认补机器人
    if (room.config.mode === 'training' || room.config.fillWithBots) {
      fillBots(room);
    }

    touch(room);
    broadcastState(room);
  }));

  // ===== 训练模式：补机器人 / 重置筹码 =====
  socket.on('training:fill', safeHandler(socket, (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    const count = Number.isInteger(payload && payload.count)
      ? payload.count
      : room.config.botCount;
    fillBots(room, count, payload && payload.difficulty);
    touch(room);
    broadcastState(room);
  }));

  socket.on('training:reset', safeHandler(socket, (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;
    if (room.game.isHandInProgress()) {
      socket.emit('error', '本局进行中，无法重置筹码');
      return;
    }
    room.game.resetChips(payload && payload.chips);
    touch(room);
    broadcastState(room);
  }));

  // ===== 训练模式：胜率查询（PRD-03 §3.3）=====
  socket.on('equity:request', safeHandler(socket, (payload = {}) => {
    const room = rooms.get(socket.data.roomId);
    if (!room) return;

    // 只允许查询自己的底牌
    const player = room.game.players.find(p => p.id === socket.data.playerId);
    if (!player) {
      socket.emit('equity:result', { error: '不在房间内' });
      return;
    }
    if (!player.hand || player.hand.length !== 2) {
      socket.emit('equity:result', { error: '当前没有底牌' });
      return;
    }
    if (room.game.isHandInProgress() === false) {
      socket.emit('equity:result', { error: '牌局未开始' });
      return;
    }

    // 限流：同一玩家 1 秒最多 1 次
    const now = Date.now();
    if (!room.equityLastAt) room.equityLastAt = new Map();
    const last = room.equityLastAt.get(player.id) || 0;
    if (now - last < 1000) {
      socket.emit('equity:result', { error: '请求过于频繁' });
      return;
    }
    room.equityLastAt.set(player.id, now);

    // 对手数量：未弃牌的其他玩家
    const opponentCount = room.game.players
      .filter(p => !p.folded && p.id !== player.id).length;

    if (opponentCount < 1) {
      socket.emit('equity:result', { error: '没有对手' });
      return;
    }

    try {
      const result = equity({
        hole: player.hand,
        board: room.game.community,
        opponents: Math.min(opponentCount, 6),
        iterations: EQUITY_ITERATIONS
      });
      socket.emit('equity:result', {
        equity: result.equity,
        win: result.win,
        tie: result.tie,
        lose: result.lose,
        iterations: result.iterations,
        cached: result.cached
      });
    } catch (err) {
      socket.emit('equity:result', { error: '计算失败' });
    }
  }));
});

// 补机器人（训练模式）
function fillBots(room, count, difficulty) {
  const target = Math.min(
    Number.isInteger(count) ? count : room.config.botCount,
    MAX_PLAYERS
  );
  const diff = difficulty && ['easy', 'normal', 'hard'].includes(difficulty)
    ? difficulty
    : room.config.botDifficulty;
  const added = room.game.fillWithBots(target, diff);
  if (added.length) {
    room.game.addLog(`补充 ${added.length} 个机器人（${diff}）`);
  }
  return added;
}

// 显式离开：立即弃牌 + 立即移除（不进入宽限期）
function handleLeave(socket) {
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) {
    socket.data.roomId = null;
    socket.data.playerId = null;
    socket.data.spectating = false;
    return;
  }

  // 观战者离开：从独立列表移除即可
  if (socket.data.spectating) {
    room.spectators.delete(socket.id);
    socket.data.roomId = null;
    socket.data.spectating = false;
    touch(room);
    if (room.playerIds.size === 0 && room.spectators.size === 0 && room.game.players.length === 0) {
      clearTurnTimer(room);
      if (room.botScheduler) room.botScheduler.stop();
      rooms.delete(roomId);
      return;
    }
    broadcastState(room);
    return;
  }

  const playerId = socket.data.playerId;
  if (!playerId) return;

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

    // 房主离开时顺延给下一位在线真人（PRD-04 §3.2）
    if (room.hostId === playerId) {
      const next = room.game.players.find(p => !p.isBot && !p.disconnected)
        || room.game.players.find(p => !p.disconnected);
      room.hostId = next ? next.id : null;
    }
    touch(room);
  }

  room.playerIds.delete(socket.id);
  socket.data.roomId = null;
  socket.data.playerId = null;

  if (room.playerIds.size === 0 && room.spectators.size === 0 && room.game.players.length === 0) {
    clearTurnTimer(room);
    if (room.botScheduler) room.botScheduler.stop();
    rooms.delete(roomId);
    return;
  }
  afterStateChange(room);
}

// 断线：保留座位 + 宽限期，不立即弃牌（PRD-02 §3.3）
function handleDisconnect(socket) {
  const roomId = socket.data.roomId;
  const playerId = socket.data.playerId;
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) {
    socket.data.roomId = null;
    socket.data.playerId = null;
    socket.data.spectating = false;
    return;
  }

  // 观战者断线：直接移除
  if (socket.data.spectating) {
    room.spectators.delete(socket.id);
    socket.data.roomId = null;
    socket.data.spectating = false;
    if (room.playerIds.size === 0 && room.spectators.size === 0 && room.game.players.length === 0) {
      clearTurnTimer(room);
      if (room.botScheduler) room.botScheduler.stop();
      rooms.delete(roomId);
      return;
    }
    broadcastState(room);
    return;
  }

  if (!playerId) return;

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
    afterStateChange(room);
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
      clearLevelTimer(room);
      if (room.botScheduler) room.botScheduler.stop();
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
    clearLevelTimer(room);
    if (room.botScheduler) room.botScheduler.stop();
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
