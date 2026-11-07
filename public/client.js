const socket = io();

let myPlayerId = null;
let currentState = null;
let myChips = 0;

// DOM 引用
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const roomIdDisplay = document.getElementById('room-id-display');
const copyRoomBtn = document.getElementById('copy-room');
const leaveBtn = document.getElementById('leave-btn');

const playerSeats = document.getElementById('player-seats');
const communityCardsEl = document.getElementById('community-cards');
const potAmountEl = document.getElementById('pot-amount');
const stageDisplayEl = document.getElementById('stage-display');

const turnInfo = document.getElementById('turn-info');
const callAmountEl = document.getElementById('call-amount');
const minRaiseEl = document.getElementById('min-raise');
const actionBtns = document.querySelectorAll('.btn-action');
const raiseSlider = document.getElementById('raise-slider');
const raiseInput = document.getElementById('raise-input');
const startArea = document.getElementById('start-area');
const startBtn = document.getElementById('start-btn');

const gameLogEl = document.getElementById('game-log');
const chatMessagesEl = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');

const resultModal = document.getElementById('result-modal');
const resultDetails = document.getElementById('result-details');
const resultClose = document.getElementById('result-close');
const resultNext = document.getElementById('result-next');
let shownResultHand = -1;

// ===== 登录 =====
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();
  if (!name || !room) {
    alert('请输入昵称和房间号');
    return;
  }
  joinRoom(name, room);
});

// ===== 会话持久化（PRD-02 §5）=====
const SESSION_KEY = (roomId) => `poker:${roomId}`;
let myToken = null;
let myName = null;
let currentRoomId = null;
let retriedJoin = false;

function loadSession(roomId) {
  try {
    const raw = localStorage.getItem(SESSION_KEY(roomId));
    return raw ? JSON.parse(raw) : null;
  } catch (_) {
    return null;
  }
}

function saveSession(roomId, data) {
  try {
    localStorage.setItem(SESSION_KEY(roomId), JSON.stringify(data));
  } catch (_) {
    // localStorage 不可用（隐私模式）时静默降级为不记忆
  }
}

function clearSession(roomId) {
  try {
    localStorage.removeItem(SESSION_KEY(roomId));
  } catch (_) { /* ignore */ }
}

function joinRoom(name, room) {
  const saved = loadSession(room);
  const payload = { roomId: room, name };
  if (saved && saved.playerId && saved.token) {
    // 带上凭证尝试重连（服务端会校验，失败则提示）
    payload.playerId = saved.playerId;
    payload.token = saved.token;
  }
  socket.emit('join', payload);
}

// ===== 连接状态横幅 =====
const connBanner = document.getElementById('conn-banner');

function showBanner(text, ok = false) {
  connBanner.textContent = text;
  connBanner.classList.remove('hidden');
  connBanner.classList.toggle('ok', ok);
}

function hideBanner() {
  connBanner.classList.add('hidden');
}

socket.on('connect', () => {
  // 已登录过就自动带凭证重连
  if (currentRoomId && myName) {
    showBanner('连接已断开，正在重连…');
    joinRoom(myName, currentRoomId);
  }
});

socket.on('disconnect', () => {
  showBanner('连接已断开，正在重连…');
});

socket.on('session:replaced', ({ message } = {}) => {
  showBanner(message || '会话已被其他窗口接管');
  setTimeout(() => location.reload(), 1500);
});

socket.on('joined', ({ playerId, roomId, token, reconnected }) => {
  myPlayerId = playerId;
  currentRoomId = roomId;
  if (token) myToken = token;

  const name = nameInput.value.trim() || myName || '';
  myName = name;
  saveSession(roomId, { playerId, token: myToken, name });

  loginScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  roomIdDisplay.textContent = roomId;

  if (reconnected) showBanner('已恢复座位', true);
  setTimeout(hideBanner, 2000);
});

socket.on('error', (msg) => {
  // 重连凭证失效/座位已不存在时，清掉本地会话并回退为“新玩家加入”
  if (typeof msg === 'string' && msg.includes('重连')) {
    if (currentRoomId) clearSession(currentRoomId);
    myToken = null;

    if (currentRoomId && myName && !retriedJoin) {
      retriedJoin = true;
      socket.emit('join', { roomId: currentRoomId, name: myName });
      return;
    }
  }
  alert(msg);
});

// ===== 离开 =====
leaveBtn.addEventListener('click', () => {
  if (currentRoomId) clearSession(currentRoomId);
  socket.emit('leave');
  location.reload();
});

copyRoomBtn.addEventListener('click', () => {
  const text = roomIdDisplay.textContent;
  navigator.clipboard.writeText(text).then(() => {
    copyRoomBtn.textContent = '已复制';
    setTimeout(() => copyRoomBtn.textContent = '复制', 1500);
  });
});

// ===== 开始游戏 =====
startBtn.addEventListener('click', () => {
  socket.emit('start');
});

// ===== 玩家操作 =====
actionBtns.forEach(btn => {
  btn.addEventListener('click', () => {
    const action = btn.dataset.action;
    let amount = 0;
    if (action === 'raise') {
      amount = parseInt(raiseInput.value) || 0;
    }
    socket.emit('action', { action, amount });
  });
});

raiseSlider.addEventListener('input', () => {
  raiseInput.value = raiseSlider.value;
});
raiseInput.addEventListener('input', () => {
  raiseSlider.value = raiseInput.value;
});

// ===== 聊天 =====
function sendChat() {
  const text = chatInput.value.trim();
  if (!text) return;
  socket.emit('chat', text);
  chatInput.value = '';
}
chatSendBtn.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

socket.on('chat', ({ name, text, system }) => {
  const div = document.createElement('div');
  div.className = 'chat-msg' + (system ? ' system' : '');
  if (system) {
    div.textContent = text;
  } else {
    div.innerHTML = `<span class="name">${name}:</span> ${escapeHtml(text)}`;
  }
  chatMessagesEl.appendChild(div);
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== 状态渲染 =====
socket.on('state', (state) => {
  currentState = state;
  render(state);
});

// ===== 训练模式 HUD（PRD-03 §5）=====
const trainingPanel = document.getElementById('training-panel');
const trainingToggle = document.getElementById('training-toggle');
const trainingHandEl = document.getElementById('training-hand');
const trainingEquityEl = document.getElementById('training-equity');
const trainingOddsEl = document.getElementById('training-odds');
const trainingOutsEl = document.getElementById('training-outs');
const trainingRefresh = document.getElementById('training-refresh');

let trainingEnabled = false;
let lastEquityRequestAt = 0;

function setTrainingEnabled(enabled) {
  trainingEnabled = enabled;
  trainingPanel.classList.toggle('hidden', !enabled);
  trainingToggle.classList.toggle('active', enabled);
  if (enabled) {
    trainingToggle.textContent = '训练模式：开';
    requestEquity();
  } else {
    trainingToggle.textContent = '训练模式';
    trainingHandEl.textContent = '—';
    trainingEquityEl.textContent = '—';
    trainingOddsEl.textContent = '—';
    trainingOutsEl.textContent = '—';
  }
}

trainingToggle.addEventListener('click', () => setTrainingEnabled(!trainingEnabled));
trainingRefresh.addEventListener('click', () => {
  lastEquityRequestAt = 0;
  requestEquity();
});

function requestEquity() {
  if (!trainingEnabled || !currentState) return;
  if (!['preflop', 'flop', 'turn', 'river'].includes(currentState.stage)) return;

  const me = currentState.players.find(p => p.isSelf);
  if (!me || !me.hand || me.hand.length !== 2) return;

  const now = Date.now();
  if (now - lastEquityRequestAt < 1000) return;
  lastEquityRequestAt = now;

  socket.emit('equity:request', {});
}

socket.on('equity:result', (r) => {
  if (!trainingEnabled) return;
  if (!r || r.error) {
    trainingEquityEl.textContent = r && r.error ? r.error : '—';
    return;
  }
  const pct = (r.equity * 100).toFixed(0);
  trainingEquityEl.textContent = `${pct}%`;
  trainingEquityEl.classList.toggle('ahead', r.equity >= 0.5);
  trainingEquityEl.classList.toggle('behind', r.equity < 0.5);
});

function renderTraining(state) {
  if (!trainingEnabled) return;
  const me = state.players.find(p => p.isSelf);
  if (!me) return;

  // 底池赔率
  const callAmount = state.callAmount || 0;
  if (callAmount > 0) {
    const odds = callAmount / (state.pot + callAmount);
    trainingOddsEl.textContent = `${callAmount} / ${state.pot + callAmount} → 需 ${(odds * 100).toFixed(0)}%`;
  } else {
    trainingOddsEl.textContent = '无需跟注';
  }

  // 当前牌型（粗算：仅当公共牌 >= 3 张时请求服务端评估结果）
  const cards = [...(me.hand || []), ...(state.community || [])];
  trainingHandEl.textContent = cards.length >= 5 ? '见结算' : `${cards.length} 张`;

  // 听牌数：粗略估算（同花/顺子差一张）
  trainingOutsEl.textContent = estimateOuts(me.hand || [], state.community || []);
}

function estimateOuts(hole, board) {
  const all = [...hole, ...board];
  if (all.length < 4) return '—';

  const suitCount = {};
  for (const c of all) suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
  const maxSuit = Math.max(...Object.values(suitCount));
  if (maxSuit === 4) return '≈9（同花听牌）';

  const vals = new Set(all.map(c => ({ '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,'J':11,'Q':12,'K':13,'A':14 }[c.rank])));
  const sorted = [...vals].sort((a, b) => a - b);
  let run = 1;
  let best = 1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1] + 1) { run++; best = Math.max(best, run); }
    else run = 1;
  }
  if (best === 4) return '≈8（顺子听牌）';
  return '0';
}

// ===== 回合倒计时（PRD-02 §4.3）=====
const turnCountdownEl = document.getElementById('turn-countdown');
let countdownTimer = null;
let clockOffsetMs = 0; // 服务端时间 - 本地时间

function startCountdown(state) {
  stopCountdown();

  if (!state.turnDeadline) {
    turnCountdownEl.classList.add('hidden');
    return;
  }

  const myTurn = state.myTurn;
  // 服务端时间偏差校准：以收到的 deadline 为基准，本地倒计时按差值推进
  clockOffsetMs = 0;

  const tick = () => {
    const remaining = Math.max(0, state.turnDeadline - (Date.now() + clockOffsetMs));
    const secs = Math.ceil(remaining / 1000);
    turnCountdownEl.classList.remove('hidden');
    turnCountdownEl.textContent = `${myTurn ? '剩余' : '等待'} ${secs}s`;
    turnCountdownEl.classList.toggle('warning', remaining <= 10000);

    if (remaining <= 0) {
      stopCountdown();
      turnCountdownEl.classList.add('hidden');
    }
  };

  tick();
  countdownTimer = setInterval(tick, 250);
}

function stopCountdown() {
  if (countdownTimer) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

function render(state) {
  // 阶段
  const stageNames = {
    waiting: '等待开始', preflop: '翻牌前', flop: '翻牌',
    turn: '转牌', river: '河牌', showdown: '摊牌', ended: '本局结束'
  };
  stageDisplayEl.textContent = stageNames[state.stage] || state.stage;

  // 底池
  potAmountEl.textContent = state.pot;

  // 社区牌
  renderCommunity(state.community);

  // 玩家座位
  renderSeats(state);

  // 操作区
  renderActions(state);

  // 回合倒计时（PRD-02）
  startCountdown(state);

  // 训练 HUD（PRD-03）
  renderTraining(state);
  if (trainingEnabled) requestEquity();

  // 日志
  renderLog(state.log);

  // 开始按钮
  if (state.stage === 'waiting' || state.stage === 'ended') {
    startArea.style.display = 'block';
    startBtn.textContent = state.stage === 'ended' ? '开始下一局' : '开始游戏';
  } else {
    startArea.style.display = 'none';
  }

  // 结算弹窗（同一局只弹一次，关掉后不会因广播重新弹出）
  if (state.stage === 'ended' && state.winners && state.winners.length > 0) {
    if (shownResultHand !== state.handCount) {
      shownResultHand = state.handCount;
      showResult(state.winners, state.players);
    }
  } else {
    resultModal.classList.add('hidden');
  }
}

function cardHTML(card, hidden = false) {
  if (hidden || !card) {
    return '<div class="card back"></div>';
  }
  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  const symbol = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[card.suit];
  return `<div class="card ${isRed ? 'red' : 'black'}"><span class="rank">${card.rank}</span><span class="suit">${symbol}</span></div>`;
}

function renderCommunity(cards) {
  communityCardsEl.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    if (cards[i]) {
      communityCardsEl.innerHTML += cardHTML(cards[i]);
    } else {
      communityCardsEl.innerHTML += '<div class="card back" style="opacity:0.3"></div>';
    }
  }
}

function renderSeats(state) {
  playerSeats.innerHTML = '';
  const players = state.players;
  const n = players.length;
  if (n === 0) return;

  // 找到自己的位置，把自己放在底部
  let selfIdx = players.findIndex(p => p.isSelf);
  if (selfIdx < 0) selfIdx = 0;

  // 座位在椭圆周围的位置（百分比）
  // 我们希望 self 在底部 (angle = π/2)
  players.forEach((p, i) => {
    // 相对 self 的偏移
    let rel = (i - selfIdx + n) % n;
    // 在椭圆上均匀分布，起点在底部
    // angle from bottom, going clockwise
    const angle = (rel / n) * Math.PI * 2 + Math.PI / 2;
    // 椭圆半径：水平 47%, 垂直 44%
    const x = 50 + 47 * Math.cos(angle);
    const y = 50 + 43 * Math.sin(angle);

    const seat = document.createElement('div');
    seat.className = 'seat';
    if (p.isSelf) seat.classList.add('is-self');
    if (p.folded) seat.classList.add('folded');
    if (state.currentPlayerIndex === p.index && state.stage !== 'waiting' && state.stage !== 'ended' && state.stage !== 'showdown') {
      seat.classList.add('active-turn');
    }
    seat.style.left = x + '%';
    seat.style.top = y + '%';

    let tags = '';
    if (p.index === state.buttonIndex) tags += '<span class="tag btn">D</span>';
    // 盲注标签（仅在翻牌前显示）：直接使用服务端计算的下标，避免破产座位导致错位
    if (state.stage === 'preflop') {
      if (p.index === state.sbIndex) tags += '<span class="tag sb">SB</span>';
      if (p.index === state.bbIndex) tags += '<span class="tag bb">BB</span>';
    }

    const handCards = (p.hand && p.hand.length > 0)
      ? p.hand.map(c => cardHTML(c)).join('')
      : (state.stage !== 'waiting' && state.stage !== 'ended' ? '<div class="card back"></div><div class="card back"></div>' : '');

    const betText = p.currentBet > 0 ? `下注 ${p.currentBet}` : (p.allIn ? 'ALL-IN' : '');

    seat.innerHTML = `
      <div class="avatar">${p.name.charAt(0).toUpperCase()}</div>
      ${tags}
      <div class="name">${escapeHtml(p.name)}${p.isBot ? '<span class="bot-tag">BOT</span>' : ''}${p.disconnected ? ' (离线)' : ''}</div>
      <div class="chips">${p.chips}</div>
      <div class="player-cards">${handCards}</div>
      <div class="bet-indicator">${betText}</div>
    `;
    playerSeats.appendChild(seat);
  });
}

function renderActions(state) {
  const me = state.players.find(p => p.isSelf);
  if (!me) return;

  const myTurn = state.myTurn;
  const stage = state.stage;
  const canAct = myTurn && !me.folded && !me.allIn && stage !== 'waiting' && stage !== 'ended' && stage !== 'showdown';

  // 显示跟注/加注信息
  callAmountEl.textContent = state.callAmount;
  minRaiseEl.textContent = state.minRaiseTo;

  // 设置加注输入范围
  if (me) {
    const maxRaise = me.chips + me.currentBet;
    raiseSlider.min = Math.min(state.minRaiseTo, maxRaise);
    raiseSlider.max = maxRaise;
    if (parseInt(raiseInput.value) < state.minRaiseTo || parseInt(raiseInput.value) > maxRaise) {
      raiseInput.value = Math.min(Math.max(state.minRaiseTo, parseInt(raiseInput.value) || state.minRaiseTo), maxRaise);
      raiseSlider.value = raiseInput.value;
    }
  }

  // 按钮可用性
  document.querySelector('[data-action="fold"]').disabled = !canAct;
  document.querySelector('[data-action="check"]').disabled = !canAct || state.callAmount > 0;
  document.querySelector('[data-action="call"]').disabled = !canAct || state.callAmount <= 0;
  document.querySelector('[data-action="raise"]').disabled = !canAct || state.minRaiseTo > (me.chips + me.currentBet);
  document.querySelector('[data-action="allin"]').disabled = !canAct || me.chips <= 0;

  // 回合提示
  if (stage === 'waiting') {
    turnInfo.textContent = '点击"开始新一局"开始游戏';
  } else if (stage === 'ended') {
    turnInfo.textContent = '本局结束，点击"开始新一局"继续';
  } else if (stage === 'showdown') {
    turnInfo.textContent = '摊牌中...';
  } else if (myTurn) {
    turnInfo.textContent = '轮到你行动！';
  } else {
    const cur = state.players[state.currentPlayerIndex];
    turnInfo.textContent = cur ? `等待 ${cur.name} 行动...` : '等待中...';
  }

  // 隐藏不需要的按钮
  document.querySelector('[data-action="check"]').style.display = state.callAmount === 0 ? '' : 'none';
  document.querySelector('[data-action="call"]').style.display = state.callAmount > 0 ? '' : 'none';
}

function renderLog(logs) {
  gameLogEl.innerHTML = '';
  for (const line of logs) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.textContent = line;
    gameLogEl.appendChild(div);
  }
  gameLogEl.scrollTop = gameLogEl.scrollHeight;
}

function showResult(winners, players) {
  resultDetails.innerHTML = '';
  for (const w of winners) {
    const div = document.createElement('div');
    div.className = 'result-item';
    let cardsHtml = '';
    if (w.hand) {
      cardsHtml = '<div class="result-cards">' + w.hand.map(c => cardHTML(c)).join('') + '</div>';
    }
    div.innerHTML = `
      <div class="winner-name">${escapeHtml(w.name)}</div>
      <div class="win-amount">+${w.amount}</div>
      ${w.handName ? `<div class="hand-name">${w.handName}</div>` : ''}
      ${cardsHtml}
    `;
    resultDetails.appendChild(div);
  }
  resultModal.classList.remove('hidden');
}

resultClose.addEventListener('click', () => {
  resultModal.classList.add('hidden');
});

// 结算弹窗里直接开下一局
resultNext.addEventListener('click', () => {
  resultModal.classList.add('hidden');
  socket.emit('start');
});

// 回车快捷操作
document.addEventListener('keydown', (e) => {
  if (loginScreen.classList.contains('hidden')) {
    if (e.key === 'Escape') resultModal.classList.add('hidden');
  }
});

// 默认填入随机昵称
if (!nameInput.value) {
  nameInput.value = '玩家' + Math.floor(Math.random() * 1000);
}
if (!roomInput.value) {
  roomInput.value = 'poker' + Math.floor(Math.random() * 10000);
}
