const socket = io();

let myPlayerId = null;
let currentState = null;
let myChips = 0;
let isSpectator = false;

// DOM 引用
const loginScreen = document.getElementById('login-screen');
const gameScreen = document.getElementById('game-screen');
const nameInput = document.getElementById('name-input');
const roomInput = document.getElementById('room-input');
const joinBtn = document.getElementById('join-btn');
const spectateBtn = document.getElementById('spectate-btn');
const roomIdDisplay = document.getElementById('room-id-display');
const copyRoomBtn = document.getElementById('copy-room');
const inviteBtn = document.getElementById('invite-btn');
const leaveBtn = document.getElementById('leave-btn');
const spectatorBadge = document.getElementById('spectator-badge');

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

const lobbyBar = document.getElementById('lobby-bar');
const lobbyInfo = document.getElementById('lobby-info');
const readyBtn = document.getElementById('ready-btn');

const settingsBtn = document.getElementById('settings-btn');
const settingsModal = document.getElementById('settings-modal');
const settingsClose = document.getElementById('settings-close');
const soundToggle = document.getElementById('sound-toggle');
const animToggle = document.getElementById('anim-toggle');
const hostSettings = document.getElementById('host-settings');
const requireReadyToggle = document.getElementById('require-ready');
const spectatorSeeAllToggle = document.getElementById('spectator-see-all');
const cfgSmallBlind = document.getElementById('cfg-small-blind');
const cfgBigBlind = document.getElementById('cfg-big-blind');
const cfgChips = document.getElementById('cfg-chips');
const hostSettingsTip = document.getElementById('host-settings-tip');

const toastEl = document.getElementById('toast');
const drawerToggle = document.getElementById('drawer-toggle');
const sidebarEl = document.getElementById('sidebar');

const gameLogEl = document.getElementById('game-log');
const chatMessagesEl = document.getElementById('chat-messages');
const chatInput = document.getElementById('chat-input');
const chatSendBtn = document.getElementById('chat-send');

const resultModal = document.getElementById('result-modal');
const resultBoard = document.getElementById('result-board');
const resultDetails = document.getElementById('result-details');
const resultPots = document.getElementById('result-pots');
const resultClose = document.getElementById('result-close');
const resultNext = document.getElementById('result-next');
const resultShare = document.getElementById('result-share');
const resultCountdown = document.getElementById('result-countdown');
let shownResultHand = -1;

// ===== 轻提示 =====
let toastTimer = null;
function showToast(text, ms = 1800) {
  toastEl.textContent = text;
  toastEl.classList.remove('hidden');
  // 强制回流后再加 show，保证过渡生效
  void toastEl.offsetWidth;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove('show');
    setTimeout(() => toastEl.classList.add('hidden'), 260);
  }, ms);
}

// ===== 登录 =====
joinBtn.addEventListener('click', () => {
  const name = nameInput.value.trim();
  const room = roomInput.value.trim();
  if (!name || !room) {
    alert('请输入昵称和房间号');
    return;
  }
  Sound.unlock();
  joinRoom(name, room);
});

spectateBtn.addEventListener('click', () => {
  const room = roomInput.value.trim();
  if (!room) {
    alert('请输入房间号');
    return;
  }
  const name = nameInput.value.trim() || '观众';
  Sound.unlock();
  socket.emit('join', { roomId: room, name, spectate: true });
});

// ===== 邀请链接（PRD-04 §3.1）=====
// 打开 /?room=xxx 时自动填房间号并聚焦昵称
(function initFromUrl() {
  try {
    const params = new URLSearchParams(location.search);
    const room = params.get('room');
    if (room) {
      roomInput.value = room;
      nameInput.focus();
      nameInput.select();
    }
  } catch (_) { /* ignore */ }
})();

function buildInviteUrl() {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', roomIdDisplay.textContent);
  return url.toString();
}

inviteBtn.addEventListener('click', async () => {
  const url = buildInviteUrl();
  // 优先系统分享
  if (navigator.share) {
    try {
      await navigator.share({ title: '德州扑克', text: '来一起打牌吧', url });
      return;
    } catch (_) {
      // 用户取消或失败 → 回退到复制
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('已复制邀请链接');
  } catch (_) {
    showToast(`邀请链接：${url}`, 5000);
  }
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

socket.on('joined', ({ playerId, roomId, token, reconnected, spectator, name }) => {
  myPlayerId = playerId || null;
  currentRoomId = roomId;
  isSpectator = !!spectator;
  if (token) myToken = token;

  const displayName = name || nameInput.value.trim() || myName || '';
  myName = displayName;
  if (!spectator) saveSession(roomId, { playerId, token: myToken, name: displayName });

  loginScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  roomIdDisplay.textContent = roomId;
  spectatorBadge.classList.toggle('hidden', !spectator);

  // 写入地址栏，刷新不丢（PRD-04 §3.1）
  try {
    const url = new URL(location.href);
    url.searchParams.set('room', roomId);
    history.replaceState(null, '', url);
  } catch (_) { /* ignore */ }

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

// ===== 准备（PRD-04 §3.2）=====
readyBtn.addEventListener('click', () => {
  const me = currentState && currentState.players.find(p => p.isSelf);
  socket.emit('ready', { ready: me ? !me.ready : true });
});

// ===== 设置面板（PRD-04 §3.4 / §3.2）=====
const SETTINGS_KEY = 'poker:settings';

function loadSettings() {
  let s = { sound: true, anim: true };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) s = { ...s, ...JSON.parse(raw) };
  } catch (_) { /* ignore */ }
  return s;
}

function saveSettings(s) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch (_) { /* ignore */ }
}

const settings = loadSettings();

function applySettings() {
  Sound.setEnabled(settings.sound);
  soundToggle.checked = settings.sound;
  animToggle.checked = settings.anim;
  document.body.classList.toggle('no-anim', !settings.anim);
}

applySettings();

soundToggle.addEventListener('change', () => {
  settings.sound = soundToggle.checked;
  Sound.setEnabled(settings.sound);
  saveSettings(settings);
  if (settings.sound) {
    Sound.unlock();
    Sound.chip();
  }
});

animToggle.addEventListener('change', () => {
  settings.anim = animToggle.checked;
  document.body.classList.toggle('no-anim', !settings.anim);
  saveSettings(settings);
});

settingsBtn.addEventListener('click', () => {
  settingsModal.classList.remove('hidden');
  syncHostSettings();
});

settingsClose.addEventListener('click', () => settingsModal.classList.add('hidden'));

function syncHostSettings() {
  if (!currentState) return;
  const isHost = !!currentState.isHost;
  hostSettings.classList.toggle('hidden', !isHost);
  if (!isHost) return;

  requireReadyToggle.checked = !!currentState.requireReady;
  spectatorSeeAllToggle.checked = !!currentState.spectatorSeeAll;
  if (currentState.smallBlind) cfgSmallBlind.value = currentState.smallBlind;
  if (currentState.bigBlind) cfgBigBlind.value = currentState.bigBlind;

  const inProgress = ['preflop', 'flop', 'turn', 'river', 'showdown'].includes(currentState.stage);
  hostSettingsTip.textContent = inProgress
    ? '牌局进行中无法修改配置。'
    : '修改后立即生效，下一局使用新配置。';
  for (const el of [requireReadyToggle, spectatorSeeAllToggle, cfgSmallBlind, cfgBigBlind, cfgChips]) {
    el.disabled = inProgress;
  }
}

function pushHostConfig() {
  socket.emit('host:config', {
    requireReady: requireReadyToggle.checked,
    spectatorSeeAll: spectatorSeeAllToggle.checked,
    smallBlind: parseInt(cfgSmallBlind.value) || undefined,
    bigBlind: parseInt(cfgBigBlind.value) || undefined,
    startingChips: parseInt(cfgChips.value) || undefined
  });
}

requireReadyToggle.addEventListener('change', pushHostConfig);
spectatorSeeAllToggle.addEventListener('change', pushHostConfig);
for (const el of [cfgSmallBlind, cfgBigBlind, cfgChips]) {
  el.addEventListener('change', pushHostConfig);
}

// ===== 移动端抽屉（PRD-04 §3.6）=====
drawerToggle.addEventListener('click', () => {
  sidebarEl.classList.toggle('open');
});

// ===== 快捷键（PRD-04 §3.7）=====
document.addEventListener('keydown', (e) => {
  // 输入框/文本域聚焦时不触发快捷键
  const tag = (e.target && e.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;

  if (loginScreen.classList.contains('hidden')) {
    if (e.key === 'Escape') {
      resultModal.classList.add('hidden');
      settingsModal.classList.add('hidden');
      sidebarEl.classList.remove('open');
      return;
    }
    if (resultModal.classList.contains('hidden') && settingsModal.classList.contains('hidden')) {
      const key = e.key.toLowerCase();
      const map = { f: 'fold', c: 'call', r: 'raise', a: 'allin' };
      if (key === 'c') {
        // C = 跟注或过牌
        const callBtn = document.querySelector('[data-action="call"]');
        const checkBtn = document.querySelector('[data-action="check"]');
        const target = (callBtn && !callBtn.disabled && callBtn.style.display !== 'none') ? callBtn : checkBtn;
        if (target && !target.disabled) { e.preventDefault(); target.click(); }
        return;
      }
      const action = map[key];
      if (!action) return;
      const btn = document.querySelector(`[data-action="${action}"]`);
      if (btn && !btn.disabled) {
        e.preventDefault();
        btn.click();
      }
    }
  }
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
    div.innerHTML = `<span class="name">${escapeHtml(name)}:</span> ${escapeHtml(text)}`;
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
let prevState = null;

socket.on('state', (state) => {
  playStateSounds(prevState, state);
  prevState = state;
  currentState = state;
  render(state);
});

// 音效触发（PRD-04 §3.4）：只在状态真正变化时响
function playStateSounds(prev, next) {
  if (!prev || prev.handCount !== next.handCount) {
    Sound.deal();
    return;
  }
  if ((next.community || []).length > (prev.community || []).length) {
    Sound.flip();
  }
  const prevPot = prev.pot || 0;
  if (next.pot > prevPot && next.stage !== 'ended') {
    Sound.chip();
  }
}

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

  // 观战徽章
  spectatorBadge.classList.toggle('hidden', !state.spectator);

  // 底池
  potAmountEl.textContent = state.pot;

  // 社区牌（翻牌时加动画）
  renderCommunity(state.community);

  // 玩家座位
  renderSeats(state);

  // 大厅 / 准备区（PRD-04 §3.2）
  renderLobby(state);

  // 锦标赛 UI（PRD-05）
  renderTournament(state);

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
    // 非房主不能开局（PRD-04 §3.2）
    const blocked = state.hostId && !state.isHost;
    startBtn.disabled = !!blocked || state.spectator;
    startBtn.title = blocked ? '等待房主开始' : '';
  } else {
    startArea.style.display = 'none';
  }

  // 结算弹窗（同一局只弹一次，关掉后不会因广播重新弹出）
  if (state.stage === 'ended' && state.result) {
    if (shownResultHand !== state.handCount) {
      shownResultHand = state.handCount;
      showResult(state);
    }
  } else if (state.stage !== 'ended') {
    resultModal.classList.add('hidden');
    stopResultCountdown();
  }
}

// ===== SNG 锦标赛 UI（PRD-05 §5.3）=====
const tournamentBar = document.getElementById('tournament-bar');
const tbLevel = document.getElementById('tb-level');
const tbBlinds = document.getElementById('tb-blinds');
const tbAnte = document.getElementById('tb-ante');
const tbAnteWrap = document.getElementById('tb-ante-wrap');
const tbNext = document.getElementById('tb-next');
const tbAlive = document.getElementById('tb-alive');
const tbPrize = document.getElementById('tb-prize');
const tbState = document.getElementById('tb-state');

const sngBar = document.getElementById('sng-bar');
const sngInfo = document.getElementById('sng-info');
const sngCreateBtn = document.getElementById('sng-create-btn');
const sngRegisterBtn = document.getElementById('sng-register-btn');
const sngStartBtn = document.getElementById('sng-start-btn');
const sngRematchBtn = document.getElementById('sng-rematch-btn');

const tournamentPanel = document.getElementById('tournament-panel');
const tpAlive = document.getElementById('tp-alive');
const tpAvg = document.getElementById('tp-avg');
const tpPrize = document.getElementById('tp-prize');
const tpStandings = document.getElementById('tp-standings');

const tournamentModal = document.getElementById('tournament-modal');
const tournamentChampion = document.getElementById('tournament-champion');
const tournamentFinal = document.getElementById('tournament-final');
const tournamentRematch = document.getElementById('tournament-rematch');
const tournamentClose = document.getElementById('tournament-close');

let levelCountdownTimer = null;
let shownTournamentFinish = null;

function fmtClock(ms) {
  if (ms <= 0) return '00:00';
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function renderTournament(state) {
  const t = state.tournament;

  // 级别条
  if (!t) {
    tournamentBar.classList.add('hidden');
    sngBar.classList.add('hidden');
    tournamentPanel.classList.add('hidden');
    tournamentModal.classList.add('hidden');
    stopLevelCountdown();
    return;
  }

  tournamentBar.classList.remove('hidden');
  tbLevel.textContent = t.level;
  tbBlinds.textContent = `${t.sb}/${t.bb}`;
  tbAnte.textContent = t.ante;
  tbAnteWrap.classList.toggle('hidden', !t.ante);
  tbAlive.textContent = `${t.aliveCount}/${t.playerCount}`;
  tbPrize.textContent = t.prizePool;

  const stateNames = { registering: '报名中', running: '进行中', finished: '已结束' };
  tbState.textContent = stateNames[t.state] || t.state;

  // 下一级倒计时
  startLevelCountdown(t);

  // 侧边栏面板
  tournamentPanel.classList.remove('hidden');
  tpAlive.textContent = `${t.aliveCount} / ${t.playerCount}`;
  const aliveEntrants = t.entrants.filter(e => !e.eliminated);
  const avg = aliveEntrants.length > 0
    ? Math.round(aliveEntrants.reduce((a, e) => a + (e.chips || 0), 0) / aliveEntrants.length)
    : 0;
  tpAvg.textContent = avg;
  tpPrize.textContent = t.prizePool;

  tpStandings.innerHTML = '';
  for (const e of t.entrants) {
    const row = document.createElement('div');
    row.className = 'tp-standing' + (e.eliminated ? ' out' : '');
    const me = state.players.find(p => p.id === e.playerId && p.isSelf);
    if (me) row.classList.add('me');

    const place = e.place ? `#${e.place}` : '-';
    const chips = e.eliminated ? '淘汰' : (e.chips || 0);
    const payout = e.payout > 0 ? `+${e.payout}` : '';

    row.innerHTML = `
      <span class="tp-place">${place}</span>
      <span class="tp-name">${escapeHtml(e.name)}</span>
      <span class="tp-chips">${chips}</span>
      <span class="tp-payout">${payout}</span>
    `;
    tpStandings.appendChild(row);
  }

  // 报名区
  renderSngBar(state, t);

  // 结束页
  renderTournamentFinish(state, t);
}

function renderSngBar(state, t) {
  if (state.spectator) {
    sngBar.classList.add('hidden');
    return;
  }
  sngBar.classList.remove('hidden');

  const isHost = !!state.isHost;
  const registered = t.entrants.some(e => {
    const p = state.players.find(x => x.id === e.playerId && x.isSelf);
    return !!p;
  });

  if (t.state === 'registering') {
    sngInfo.textContent = `报名中 · 买入 ${t.buyIn} · 起始 ${t.startingChips} · `
      + `已报名 ${t.playerCount}/${t.maxPlayers || 7} · 奖池 ${t.prizePool || 0}`;
    sngCreateBtn.classList.add('hidden');
    sngStartBtn.classList.toggle('hidden', !isHost);
    sngStartBtn.disabled = t.playerCount < 2;
    sngRegisterBtn.classList.remove('hidden');
    sngRegisterBtn.textContent = registered ? '取消报名' : '报名';
    sngRematchBtn.classList.add('hidden');
  } else if (t.state === 'running') {
    sngInfo.textContent = `进行中 · Level ${t.level} · ${t.sb}/${t.bb}`
      + (t.ante ? ` (前注 ${t.ante})` : '')
      + ` · 剩余 ${t.aliveCount}/${t.playerCount}`;
    sngCreateBtn.classList.add('hidden');
    sngRegisterBtn.classList.add('hidden');
    sngStartBtn.classList.add('hidden');
    sngRematchBtn.classList.add('hidden');
  } else {
    sngInfo.textContent = `已结束 · 奖池 ${t.prizePool} · 冠军 `
      + (t.entrants.find(e => e.place === 1) || {}).name;
    sngCreateBtn.classList.add('hidden');
    sngRegisterBtn.classList.add('hidden');
    sngStartBtn.classList.add('hidden');
    sngRematchBtn.classList.toggle('hidden', !isHost);
  }
}

function startLevelCountdown(t) {
  stopLevelCountdown();
  if (t.state !== 'running' || !t.levelEndsAt) {
    tbNext.textContent = t.state === 'running' ? '最后一级' : '--:--';
    return;
  }
  const tick = () => {
    const left = t.levelEndsAt - Date.now();
    tbNext.textContent = left > 0 ? fmtClock(left) : '升级中…';
    if (left <= 0) stopLevelCountdown();
  };
  tick();
  levelCountdownTimer = setInterval(tick, 500);
}

function stopLevelCountdown() {
  if (levelCountdownTimer) {
    clearInterval(levelCountdownTimer);
    levelCountdownTimer = null;
  }
}

function renderTournamentFinish(state, t) {
  if (t.state !== 'finished') {
    tournamentModal.classList.add('hidden');
    shownTournamentFinish = null;
    return;
  }
  // 同一届只弹一次
  const key = `${t.startedAt}-${t.finishedAt}`;
  if (shownTournamentFinish === key) return;
  shownTournamentFinish = key;

  const champ = t.entrants.find(e => e.place === 1);
  const isMe = champ && state.players.some(p => p.id === champ.playerId && p.isSelf);

  tournamentChampion.innerHTML = isMe
    ? `🏆 你赢了！<span class="champ-sub">第 1 名 · 奖金 ${champ.payout}</span>`
    : `🏆 ${escapeHtml((champ && champ.name) || '—')}<span class="champ-sub">第 1 名 · 奖金 ${(champ && champ.payout) || 0}</span>`;

  tournamentFinal.innerHTML = '';
  for (const e of t.entrants.slice().sort((a, b) => (a.place || 99) - (b.place || 99))) {
    const row = document.createElement('div');
    row.className = 'tf-row' + (e.place === 1 ? ' champ' : '');
    row.innerHTML = `
      <span class="tf-place">#${e.place || '-'}</span>
      <span class="tf-name">${escapeHtml(e.name)}</span>
      <span class="tf-payout">${e.payout > 0 ? '+' + e.payout : ''}</span>
    `;
    tournamentFinal.appendChild(row);
  }

  tournamentModal.classList.remove('hidden');
  if (isMe) Sound.win();
}

// 按钮事件
sngCreateBtn.addEventListener('click', () => {
  socket.emit('tournament:create', { buyIn: 100, startingChips: 1000 });
});
sngRegisterBtn.addEventListener('click', () => {
  const t = currentState && currentState.tournament;
  if (!t) return;
  const me = currentState.players.find(p => p.isSelf);
  const registered = me && t.entrants.some(e => e.playerId === me.id);
  socket.emit('tournament:register', { join: !registered });
});
sngStartBtn.addEventListener('click', () => socket.emit('tournament:start'));
sngRematchBtn.addEventListener('click', () => socket.emit('tournament:rematch'));
tournamentRematch.addEventListener('click', () => {
  tournamentModal.classList.add('hidden');
  socket.emit('tournament:rematch');
});
tournamentClose.addEventListener('click', () => tournamentModal.classList.add('hidden'));

// 淘汰浮层
socket.on('tournament:eliminated', (e) => {
  if (!e) return;
  const el = document.createElement('div');
  el.className = 'elimination-toast';
  el.textContent = `${e.name} 被淘汰 · 第 ${e.place} 名`;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
});

socket.on('tournament:level', () => {
  // 状态会随 broadcastState 一起刷新，这里只做提示
  showToast('盲注升级', 1400);
});

// 大厅渲染
function renderLobby(state) {
  const isLobby = state.stage === 'waiting' || state.stage === 'ended';
  if (!isLobby || state.spectator) {
    lobbyBar.classList.add('hidden');
    return;
  }

  lobbyBar.classList.remove('hidden');

  const humans = state.players.filter(p => !p.isBot);
  const readyIds = new Set(state.readyIds || []);
  const me = state.players.find(p => p.isSelf);

  const readyCount = humans.filter(p => readyIds.has(p.id)).length;
  const botCount = state.players.filter(p => p.isBot).length;

  let text = `玩家 ${humans.length} 人`;
  if (botCount > 0) text += ` · 机器人 ${botCount} 个`;
  if (state.requireReady) {
    text += ` · 已准备 ${readyCount}/${humans.length}`;
    const notReady = humans.filter(p => !readyIds.has(p.id)).map(p => p.name);
    if (notReady.length) text += `（等待：${notReady.join('、')}）`;
  }
  if (state.hostId) {
    const host = state.players.find(p => p.id === state.hostId);
    if (host) text += ` · 房主 ${host.name}`;
  }
  if (state.spectatorCount > 0) text += ` · 观战 ${state.spectatorCount}`;
  lobbyInfo.textContent = text;

  // 准备按钮：只有开启 requireReady 才有意义
  const showReady = state.requireReady && me;
  readyBtn.classList.toggle('hidden', !showReady);
  if (showReady) {
    const isReady = readyIds.has(me.id);
    readyBtn.textContent = isReady ? '取消准备' : '准备';
    readyBtn.classList.toggle('ready', isReady);
  }
}

// 花色形状标识（色弱友好，PRD-04 §3.7）
const SUIT_SHAPE = { spades: 'S', hearts: 'H', diamonds: 'D', clubs: 'C' };

function cardHTML(card, hidden = false, extraClass = '') {
  if (hidden || !card) {
    return '<div class="card back"></div>';
  }
  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  const symbol = { spades: '♠', hearts: '♥', diamonds: '♦', clubs: '♣' }[card.suit];
  const shape = SUIT_SHAPE[card.suit] || '';
  return `<div class="card ${isRed ? 'red' : 'black'} ${extraClass}">`
    + `<span class="rank">${card.rank}</span>`
    + `<span class="suit" data-shape="${shape}">${symbol}</span>`
    + '</div>';
}

// 记录上一次的公共牌张数，用于只在“新翻出的牌”上播放动画
let lastCommunityCount = 0;

function renderCommunity(cards) {
  const prevCount = lastCommunityCount;
  lastCommunityCount = cards.length;

  communityCardsEl.innerHTML = '';
  for (let i = 0; i < 5; i++) {
    if (cards[i]) {
      const isNew = i >= prevCount && prevCount > 0;
      const cls = isNew ? 'flip' : '';
      const style = isNew ? ` style="--flip-delay:${(i - prevCount) * 80}ms"` : '';
      communityCardsEl.innerHTML += cardHTML(cards[i], false, cls).replace('>', `${style}>`);
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

  // 找到自己的位置，把自己放在底部；观战者固定在底部
  let selfIdx = players.findIndex(p => p.isSelf);
  if (selfIdx < 0) selfIdx = 0;

  const readyIds = new Set(state.readyIds || []);

  // 座位在椭圆周围的位置（百分比）
  players.forEach((p, i) => {
    // 相对 self 的偏移
    let rel = (i - selfIdx + n) % n;
    // 在椭圆上均匀分布，起点在底部
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
    seat.setAttribute('aria-label', `${p.name}，${p.chips} 筹码${p.folded ? '，已弃牌' : ''}`);

    let tags = '';
    if (p.index === state.buttonIndex) tags += '<span class="tag btn">D</span>';
    // 盲注标签（仅在翻牌前显示）：直接使用服务端计算的下标，避免破产座位导致错位
    if (state.stage === 'preflop') {
      if (p.index === state.sbIndex) tags += '<span class="tag sb">SB</span>';
      if (p.index === state.bbIndex) tags += '<span class="tag bb">BB</span>';
    }
    // 准备标记（PRD-04 §3.2）
    if ((state.stage === 'waiting' || state.stage === 'ended') && !p.isBot) {
      tags += readyIds.has(p.id)
        ? '<span class="tag ready">✓</span>'
        : '<span class="tag not-ready">…</span>';
    }

    const handCards = (p.hand && p.hand.length > 0)
      ? p.hand.map(c => cardHTML(c, false, 'deal')).join('')
      : (state.stage !== 'waiting' && state.stage !== 'ended' ? '<div class="card back"></div><div class="card back"></div>' : '');

    const betText = p.currentBet > 0 ? `下注 ${p.currentBet}` : (p.allIn ? 'ALL-IN' : '');

    const nameParts = escapeHtml(p.name);
    const botTag = p.isBot ? '<span class="bot-tag">BOT</span>' : '';
    const hostTag = (state.hostId === p.id) ? '<span class="host-tag">房主</span>' : '';
    const offTag = p.disconnected ? ' (离线)' : '';

    seat.innerHTML = `
      <div class="avatar">${escapeHtml(p.name.charAt(0).toUpperCase())}</div>
      ${tags}
      <div class="name">${nameParts}${botTag}${hostTag}${offTag}</div>
      <div class="chips">${p.chips}</div>
      <div class="player-cards">${handCards}</div>
      <div class="bet-indicator">${betText}</div>
    `;
    playerSeats.appendChild(seat);
  });
}

function renderActions(state) {
  const me = state.players.find(p => p.isSelf);

  // 观战者：禁用所有操作（PRD-04 §3.3）
  if (state.spectator) {
    actionBtns.forEach(b => { b.disabled = true; });
    turnInfo.textContent = '观战模式：仅可查看与聊天';
    callAmountEl.textContent = '-';
    minRaiseEl.textContent = '-';
    return;
  }

  if (!me) return;

  const myTurn = state.myTurn;
  const stage = state.stage;
  const canAct = myTurn && !me.folded && !me.allIn && stage !== 'waiting' && stage !== 'ended' && stage !== 'showdown';

  // 显示跟注/加注信息
  callAmountEl.textContent = state.callAmount;
  minRaiseEl.textContent = state.minRaiseTo;

  // 设置加注输入范围
  const maxRaise = me.chips + me.currentBet;
  raiseSlider.min = Math.min(state.minRaiseTo, maxRaise);
  raiseSlider.max = maxRaise;
  if (parseInt(raiseInput.value) < state.minRaiseTo || parseInt(raiseInput.value) > maxRaise) {
    raiseInput.value = Math.min(Math.max(state.minRaiseTo, parseInt(raiseInput.value) || state.minRaiseTo), maxRaise);
    raiseSlider.value = raiseInput.value;
  }

  // 按钮可用性
  document.querySelector('[data-action="fold"]').disabled = !canAct;
  document.querySelector('[data-action="check"]').disabled = !canAct || state.callAmount > 0;
  document.querySelector('[data-action="call"]').disabled = !canAct || state.callAmount <= 0;
  document.querySelector('[data-action="raise"]').disabled = !canAct || state.minRaiseTo > maxRaise;
  document.querySelector('[data-action="allin"]').disabled = !canAct || me.chips <= 0;

  // 回合提示
  if (stage === 'waiting') {
    const blocked = state.hostId && !state.isHost;
    turnInfo.textContent = blocked ? '等待房主开始游戏' : '点击"开始游戏"开始';
  } else if (stage === 'ended') {
    turnInfo.textContent = '本局结束，点击"开始下一局"继续';
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

// ===== 结算弹窗升级（PRD-04 §3.5）=====

function cardKey(c) {
  return `${c.suit}:${c.rank}`;
}

function showResult(state) {
  const result = state.result;
  if (!result) {
    resultModal.classList.add('hidden');
    return;
  }

  // 公共牌
  resultBoard.innerHTML = '';
  if (result.board && result.board.length > 0) {
    for (const c of result.board) {
      resultBoard.innerHTML += cardHTML(c);
    }
  } else {
    resultBoard.innerHTML = '<span class="tip">无人摊牌</span>';
  }

  // 赢家集合（用于高亮）
  const winnerIds = new Set(
    (result.players || []).filter(p => p.won > 0).map(p => p.id)
  );

  // 每个玩家一行
  resultDetails.innerHTML = '';
  for (const p of result.players || []) {
    const row = document.createElement('div');
    row.className = 'result-player';
    if (winnerIds.has(p.id)) row.classList.add('winner');
    if (!p.shown) row.classList.add('folded');

    // 底牌：按 PRD-01 §3.6 reveal 规则，从 players[] 取（不重复下发）
    const playerState = state.players.find(x => x.id === p.id);
    const holeCards = (playerState && playerState.hand && playerState.hand.length > 0)
      ? playerState.hand
      : [];

    let cardsHtml = '';
    if (holeCards.length > 0) {
      // 最佳五张：非最佳牌置灰
      const bestKeys = new Set((p.bestCards || []).map(cardKey));
      cardsHtml = '<div class="rp-cards">' + holeCards.map(c => {
        const dim = bestKeys.size > 0 && !bestKeys.has(cardKey(c));
        return cardHTML(c, false, dim ? 'dim' : '');
      }).join('') + '</div>';
    }

    const handLabel = p.shown
      ? (p.handName || '')
      : '已弃牌';

    const net = p.net || 0;
    const netClass = net > 0 ? 'plus' : (net < 0 ? 'minus' : '');
    const netText = net > 0 ? `+${net}` : String(net);

    row.innerHTML = `
      <div class="rp-name">${escapeHtml(p.name)}</div>
      ${cardsHtml}
      <div class="rp-hand-name">${escapeHtml(handLabel)}</div>
      <div class="rp-net ${netClass}">${netText}</div>
    `;
    resultDetails.appendChild(row);
  }

  // 边池明细
  resultPots.innerHTML = '';
  if (result.pots && result.pots.length > 0) {
    const header = document.createElement('div');
    header.className = 'pot-line';
    header.innerHTML = '<b>边池明细</b><span></span>';
    resultPots.appendChild(header);

    result.pots.forEach((pot, i) => {
      const line = document.createElement('div');
      line.className = 'pot-line';
      const label = result.pots.length === 1 ? '主池' : (i === 0 ? '主池' : `边池 ${i}`);
      const suffix = pot.refunded ? '（退还）' : (pot.eligible.length === 0 ? '（无人可赢）' : '');
      line.innerHTML = `<span>${label}${suffix}</span><span>${pot.amount}</span>`;
      resultPots.appendChild(line);
    });
  }

  resultModal.classList.remove('hidden');
  startResultCountdown();

  // 音效：自己赢则胜利音，否则失败音
  const me = (result.players || []).find(p => {
    const ps = state.players.find(x => x.id === p.id);
    return ps && ps.isSelf;
  });
  if (me && me.net > 0) Sound.win();
  else if (me && me.net < 0) Sound.lose();
}

// 5 秒自动开始下一局（可关闭）
let resultCountdownTimer = null;
let resultCountdownLeft = 5;

function startResultCountdown() {
  stopResultCountdown();
  // 观战者、非房主不自动开局
  if (!currentState || currentState.spectator) return;
  if (currentState.hostId && !currentState.isHost) return;

  resultCountdownLeft = 5;
  resultCountdown.textContent = `（${resultCountdownLeft}s）`;

  resultCountdownTimer = setInterval(() => {
    resultCountdownLeft--;
    if (resultCountdownLeft <= 0) {
      stopResultCountdown();
      resultModal.classList.add('hidden');
      socket.emit('start');
      return;
    }
    resultCountdown.textContent = `（${resultCountdownLeft}s）`;
  }, 1000);
}

function stopResultCountdown() {
  if (resultCountdownTimer) {
    clearInterval(resultCountdownTimer);
    resultCountdownTimer = null;
  }
  if (resultCountdown) resultCountdown.textContent = '';
}

// 鼠标移入弹窗时暂停倒计时，避免误开下一局
resultModal.addEventListener('mouseenter', stopResultCountdown);
resultModal.addEventListener('mouseleave', () => {
  if (!resultModal.classList.contains('hidden')) startResultCountdown();
});

// 分享结果文本
resultShare.addEventListener('click', async () => {
  if (!currentState || !currentState.result) return;
  const r = currentState.result;
  const lines = [`第 ${r.handCount} 局结算`];
  for (const p of r.players || []) {
    const net = p.net > 0 ? `+${p.net}` : String(p.net);
    lines.push(`${p.name}: ${net}${p.handName ? `（${p.handName}）` : ''}`);
  }
  const text = lines.join('\n');
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制结算结果');
  } catch (_) {
    showToast('复制失败', 2000);
  }
});

resultClose.addEventListener('click', () => {
  stopResultCountdown();
  resultModal.classList.add('hidden');
});

// 结算弹窗里直接开下一局
resultNext.addEventListener('click', () => {
  stopResultCountdown();
  resultModal.classList.add('hidden');
  socket.emit('start');
});

// 默认填入随机昵称
if (!nameInput.value) {
  nameInput.value = '玩家' + Math.floor(Math.random() * 1000);
}
if (!roomInput.value) {
  roomInput.value = 'poker' + Math.floor(Math.random() * 10000);
}

// ===== 首次交互解锁音频（浏览器策略，PRD-04 §6）=====
['click', 'keydown', 'touchstart'].forEach(evt => {
  document.addEventListener(evt, () => Sound.unlock(), { once: true, passive: true });
});

// ===== 注册 Service Worker（PRD-04 §3.6）=====
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      // 注册失败（如非 HTTPS）时静默降级，不影响游戏
    });
  });
}
