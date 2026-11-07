// 前端静态与运行时冒烟测试（PRD-04 §6）
//
// 本项目前端无构建、无框架，引入浏览器测试框架成本过高。
// 这里用两种方式覆盖：
//   1. 资源完整性：页面引用的每个文件都可访问，关键能力字符串存在
//   2. 运行时冒烟：用极简 DOM 桩在 Node 里真实执行 client.js，
//      模拟 waiting/preflop/观战/结算/错误/聊天 六条路径，捕获运行时异常

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUB = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUB, f), 'utf8');

const html = read('index.html');
const clientJs = read('client.js');
const css = read('style.css');
const soundJs = read('sound.js');
const swJs = read('sw.js');
const manifest = JSON.parse(read('manifest.json'));

const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]));

// ===== 1. 资源完整性 =====

test('4.1 首页包含邀请/观战/设置/大厅结构', () => {
  for (const id of ['invite-btn', 'spectate-btn', 'settings-modal', 'lobby-bar', 'ready-btn',
                    'result-board', 'result-pots', 'toast', 'drawer-toggle', 'spectator-badge']) {
    assert.ok(htmlIds.has(id), `index.html 缺少 #${id}`);
  }
});

test('4.1 脚本加载顺序：sound.js 必须在 client.js 之前', () => {
  const soundIdx = html.indexOf('sound.js');
  const clientIdx = html.indexOf('client.js');
  assert.ok(soundIdx > 0, 'index.html 应引入 sound.js');
  assert.ok(soundIdx < clientIdx, 'sound.js 必须先于 client.js 加载');
});

test('4.1 client.js 引用的所有 DOM id 都存在于 HTML', () => {
  const used = [...clientJs.matchAll(/getElementById\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  const missing = [...new Set(used)].filter(id => !htmlIds.has(id));
  assert.deepStrictEqual(missing, [], `client.js 引用了不存在的 id: ${missing.join(', ')}`);
});

test('4.1 data-action 选择器都有对应元素', () => {
  const htmlActions = new Set([...html.matchAll(/data-action="([^"]+)"/g)].map(m => m[1]));
  for (const a of ['fold', 'check', 'call', 'raise', 'allin']) {
    assert.ok(htmlActions.has(a), `缺少 data-action="${a}"`);
  }
});

test('4.1 manifest 是合法 PWA 清单', () => {
  assert.ok(manifest.name);
  assert.ok(manifest.short_name);
  assert.strictEqual(manifest.display, 'standalone');
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length > 0);
  assert.strictEqual(manifest.start_url, './');
});

test('4.6 service worker 不缓存 Socket.IO', () => {
  assert.ok(swJs.includes('/socket.io/'), 'sw.js 必须显式排除 /socket.io/');
  assert.ok(swJs.includes('skipWaiting'), 'sw.js 应调用 skipWaiting');
  assert.ok(swJs.includes('CACHE_NAME'), 'sw.js 应有缓存版本号');
});

// ===== 2. 关键能力存在性 =====

test('3.1 邀请链接：读取 ?room= 并写回地址栏', () => {
  assert.ok(clientJs.includes("params.get('room')"), '应解析 ?room=');
  assert.ok(clientJs.includes('history.replaceState'), '应写回地址栏');
  assert.ok(clientJs.includes('navigator.share'), '应优先系统分享');
});

test('3.2 大厅：准备与房主配置', () => {
  assert.ok(clientJs.includes("socket.emit('ready'"), '应有准备事件');
  assert.ok(clientJs.includes("socket.emit('host:config'"), '应有房主配置事件');
  assert.ok(clientJs.includes('isHost'), '应区分房主');
});

test('3.3 观战：禁用操作', () => {
  assert.ok(clientJs.includes('观战模式'), '观战应提示观战模式');
  assert.ok(clientJs.includes('state.spectator'), '应读取 spectator 标记');
});

test('3.5 结算：最佳五张 + 边池明细', () => {
  assert.ok(clientJs.includes('bestCards'), '应渲染最佳五张');
  assert.ok(clientJs.includes('边池明细'), '应渲染边池明细');
  assert.ok(clientJs.includes('startResultCountdown'), '应有自动开局倒计时');
  assert.ok(clientJs.includes('result-share') || clientJs.includes('resultShare'), '应支持分享结果');
});

test('3.4 动画与音效', () => {
  for (const kf of ['dealIn', 'flipIn', 'chipFly', 'turnPulse']) {
    assert.ok(css.includes(`@keyframes ${kf}`), `CSS 缺少 @keyframes ${kf}`);
  }
  assert.ok(css.includes('prefers-reduced-motion'), '应尊重 prefers-reduced-motion');
  assert.ok(soundJs.includes('AudioContext'), '音效应使用 WebAudio 合成');
  assert.ok(soundJs.includes('unlock'), '音效应在用户手势后解锁');
});

test('3.6 移动端：PWA 安全区与 44px 点击区域', () => {
  assert.ok(css.includes('safe-area-inset'), '应处理 PWA 安全区');
  assert.ok(css.includes('min-height: 44px'), '操作按钮应 ≥44px');
  assert.ok(css.includes('orientation: landscape'), '应处理横屏');
});

test('3.7 可访问性：aria 与色弱标识', () => {
  assert.ok(html.includes('aria-label'), '应有 aria-label');
  assert.ok(html.includes('aria-live'), '应有 aria-live');
  assert.ok(css.includes('data-shape'), '花色应有形状/字母标识');
});

test('3.7 所有用户输入继续走 escapeHtml', () => {
  // 昵称渲染必须转义
  assert.ok(clientJs.includes('escapeHtml(p.name)'), '昵称必须 escapeHtml');
  // 不允许直接拼接未转义的 name
  const badPatterns = [
    /innerHTML\s*=\s*`[^`]*\$\{p\.name\}/,
    /innerHTML\s*=\s*`[^`]*\$\{name\}/
  ];
  for (const re of badPatterns) {
    assert.strictEqual(re.test(clientJs), false, `发现未转义的昵称拼接: ${re}`);
  }
});

// ===== 3. 运行时冒烟（极简 DOM 桩）=====

class ClassList {
  constructor() { this.set = new Set(); }
  add(...c) { c.forEach(x => this.set.add(x)); }
  remove(...c) { c.forEach(x => this.set.delete(x)); }
  toggle(c, force) {
    const on = force === undefined ? !this.set.has(c) : !!force;
    if (on) this.set.add(c); else this.set.delete(c);
    return on;
  }
  contains(c) { return this.set.has(c); }
}

class El {
  constructor(tag = 'div', id = '') {
    this.tagName = tag.toUpperCase();
    this.id = id;
    this.children = [];
    this.classList = new ClassList();
    this.style = {};
    this.dataset = {};
    this._textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.disabled = false;
    this.checked = false;
    this.title = '';
    this.listeners = {};
  }
  set textContent(v) { this._textContent = String(v); }
  get textContent() { return this._textContent; }
  set innerHTML(v) { this._innerHTML = String(v); }
  get innerHTML() { return this._innerHTML; }
  appendChild(c) { this.children.push(c); return c; }
  removeChild(c) { this.children = this.children.filter(x => x !== c); }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  removeEventListener() {}
  setAttribute(k, v) { this[k] = v; }
  getAttribute(k) { return this[k]; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
  focus() {}
  select() {}
  click() {}
  get offsetWidth() { return 100; }
  get scrollHeight() { return 100; }
  set scrollTop(v) { this._scrollTop = v; }
}

// 假定时器：记录但不真正调度
const trackedIntervals = new Map();
const trackedTimeouts = new Set();
let fakeTimerId = 0;

function buildSandbox() {
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, new El('div', id));
    return elements.get(id);
  };
  for (const id of htmlIds) getEl(id);

  const document = {
    getElementById: (id) => (htmlIds.has(id) ? getEl(id) : null),
    querySelector: (sel) => {
      const m = sel.match(/\[data-action="([^"]+)"\]/);
      if (m) { const el = new El('button'); el.dataset.action = m[1]; return el; }
      return new El();
    },
    querySelectorAll: () => ['fold', 'check', 'call', 'raise', 'allin'].map(a => {
      const el = new El('button'); el.dataset.action = a; return el;
    }),
    createElement: (tag) => new El(tag),
    addEventListener: () => {},
    body: new El('body')
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k)
  };

  const handlers = {};
  const emitted = [];
  const socketStub = {
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    emit: (ev, payload) => { emitted.push({ ev, payload }); },
    disconnect: () => {},
    connected: true
  };

  const sandbox = {
    document,
    window: {
      addEventListener: () => {},
      AudioContext: function () {
        return {
          state: 'running', currentTime: 0, resume() {},
          createOscillator: () => ({
            type: '', frequency: { setValueAtTime() {} },
            connect: () => ({ connect() {} }), start() {}, stop() {}
          }),
          createGain: () => ({
            gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect: () => ({ connect() {} })
          }),
          destination: {}
        };
      }
    },
    localStorage,
    navigator: {
      clipboard: { writeText: async () => {} },
      serviceWorker: { register: async () => {} }
    },
    location: { href: 'http://localhost:4300/', search: '', hash: '' },
    history: { replaceState: () => {} },
    URL, URLSearchParams,
    alert: () => {},
    // 冒烟测试不需要真实计时：用假定时器，避免进程被 interval 挂住
    setTimeout: (fn) => { trackedTimeouts.add(fn); return 0; },
    clearTimeout: () => {},
    setInterval: (fn) => {
      const id = ++fakeTimerId;
      trackedIntervals.set(id, fn);
      return id;
    },
    clearInterval: (id) => { trackedIntervals.delete(id); },
    console,
    Math, Date, JSON, Object, Array, Set, Map, String, Number, Boolean,
    parseInt, parseFloat, isNaN,
    requestAnimationFrame: (fn) => setTimeout(fn, 16),
    io: () => socketStub
  };

  const context = vm.createContext(sandbox);
  return { context, handlers, emitted, trackedIntervals };
}

test('4.1 client.js 在 DOM 桩下初始化无异常', () => {
  const { context } = buildSandbox();
  assert.doesNotThrow(() => {
    vm.runInContext(soundJs, context, { filename: 'sound.js' });
    vm.runInContext(clientJs, context, { filename: 'client.js' });
  }, 'client.js 初始化不应抛异常');
});

test('4.1 关键状态渲染路径无运行时错误', () => {
  const { context, handlers } = buildSandbox();
  vm.runInContext(soundJs, context, { filename: 'sound.js' });
  vm.runInContext(clientJs, context, { filename: 'client.js' });

  const fire = (ev, payload) => {
    for (const fn of handlers[ev] || []) fn(payload);
  };

  const base = {
    roomId: 't', stage: 'waiting', community: [], pot: 0, currentBet: 0,
    smallBlind: 10, bigBlind: 20, buttonIndex: 0, currentPlayerIndex: 0,
    handCount: 1, sbIndex: 0, bbIndex: 1, result: null, winners: [],
    hostId: 'p1', isHost: true, spectator: false, spectatorSeeAll: false,
    spectatorCount: 0, requireReady: false, readyIds: [],
    config: { mode: 'cash', botCount: 3, botDifficulty: 'normal' },
    turnDeadline: null, turnTimeMs: 30000,
    players: [
      { id: 'p1', name: 'Alice', chips: 1000, folded: false, allIn: false,
        currentBet: 0, totalBet: 0, hasActed: false, disconnected: false,
        isBot: false, ready: true, isSelf: true, hand: [], index: 0 },
      { id: 'p2', name: 'Bob', chips: 1000, folded: false, allIn: false,
        currentBet: 0, totalBet: 0, hasActed: false, disconnected: false,
        isBot: true, ready: true, isSelf: false, hand: [], index: 1 }
    ],
    myTurn: true, minRaiseTo: 40, callAmount: 20, log: ['第 1 局开始']
  };

  assert.doesNotThrow(() => fire('joined', { playerId: 'p1', roomId: 't', token: 'k' }));
  assert.doesNotThrow(() => fire('state', base), 'waiting 渲染失败');

  const preflop = {
    ...base,
    stage: 'preflop',
    players: base.players.map(p => p.isSelf
      ? { ...p, hand: [{ suit: 'spades', rank: 'A' }, { suit: 'hearts', rank: 'K' }] }
      : p)
  };
  assert.doesNotThrow(() => fire('state', preflop), 'preflop 渲染失败');

  const spectating = {
    ...base, spectator: true,
    players: base.players.map(p => ({ ...p, isSelf: false }))
  };
  assert.doesNotThrow(() => fire('state', spectating), '观战渲染失败');

  const ended = {
    ...base,
    stage: 'ended',
    result: {
      handCount: 1,
      board: [{ suit: 'spades', rank: '2' }, { suit: 'hearts', rank: '7' },
              { suit: 'clubs', rank: 'J' }, { suit: 'diamonds', rank: '4' },
              { suit: 'spades', rank: '9' }],
      pots: [
        { amount: 200, eligible: ['p1'], refunded: false },
        { amount: 50, eligible: [], refunded: true }
      ],
      players: [
        { id: 'p1', name: 'Alice', totalBet: 100, won: 200, refunded: 0, net: 100,
          handName: '一对',
          bestCards: [{ suit: 'spades', rank: '9' }, { suit: 'hearts', rank: '7' },
                      { suit: 'clubs', rank: 'J' }, { suit: 'diamonds', rank: '4' },
                      { suit: 'spades', rank: '2' }],
          shown: true },
        { id: 'p2', name: 'Bob', totalBet: 100, won: 0, refunded: 0, net: -100,
          handName: null, bestCards: null, shown: false }
      ]
    }
  };
  assert.doesNotThrow(() => fire('state', ended), '结算渲染失败');

  assert.doesNotThrow(() => fire('error', '测试错误'));
  assert.doesNotThrow(() => fire('chat', { name: 'Alice', text: 'hi' }));
  assert.doesNotThrow(() => fire('chat', { system: true, text: 'sys' }));
});

test('4.1 观战者不会发起行动/开局请求', () => {
  const { context, handlers, emitted } = buildSandbox();
  vm.runInContext(soundJs, context, { filename: 'sound.js' });
  vm.runInContext(clientJs, context, { filename: 'client.js' });

  const fire = (ev, payload) => { for (const fn of handlers[ev] || []) fn(payload); };

  const spectatorState = {
    roomId: 't', stage: 'waiting', community: [], pot: 0, currentBet: 0,
    smallBlind: 10, bigBlind: 20, buttonIndex: 0, currentPlayerIndex: 0,
    handCount: 1, sbIndex: 0, bbIndex: 1, result: null, winners: [],
    hostId: 'p1', isHost: false, spectator: true, spectatorSeeAll: false,
    spectatorCount: 1, requireReady: false, readyIds: [],
    config: {}, turnDeadline: null, turnTimeMs: 30000,
    players: [
      { id: 'p1', name: 'Alice', chips: 1000, folded: false, allIn: false,
        currentBet: 0, totalBet: 0, hasActed: false, disconnected: false,
        isBot: false, ready: true, isSelf: false, hand: [], index: 0 }
    ],
    myTurn: false, minRaiseTo: 40, callAmount: 0, log: []
  };

  fire('joined', { roomId: 't', spectator: true, name: 'Watcher' });
  fire('state', spectatorState);

  const actions = emitted.filter(e => e.ev === 'action' || e.ev === 'start');
  assert.deepStrictEqual(actions, [], '观战者不应发起 action/start');
});

// ===== PRD-05：锦标赛 UI =====

test('5.3 锦标赛报名/进行中/结束三种状态渲染无异常', () => {
  const { context, handlers } = buildSandbox();
  vm.runInContext(soundJs, context, { filename: 'sound.js' });
  vm.runInContext(clientJs, context, { filename: 'client.js' });

  const fire = (ev, payload) => { for (const fn of handlers[ev] || []) fn(payload); };
  const base = {
    roomId: 't', stage: 'waiting', community: [], pot: 0, currentBet: 0,
    smallBlind: 10, bigBlind: 20, buttonIndex: 0, currentPlayerIndex: 0,
    handCount: 1, sbIndex: 0, bbIndex: 1, result: null, winners: [],
    hostId: 'p1', isHost: true, spectator: false, spectatorSeeAll: false,
    spectatorCount: 0, requireReady: false, readyIds: [],
    config: {}, turnDeadline: null, turnTimeMs: 30000,
    players: [
      { id: 'p1', name: 'Alice', chips: 1000, folded: false, allIn: false,
        currentBet: 0, totalBet: 0, hasActed: false, disconnected: false,
        isBot: false, ready: true, isSelf: true, hand: [], index: 0 },
      { id: 'p2', name: 'Bob', chips: 1000, folded: false, allIn: false,
        currentBet: 0, totalBet: 0, hasActed: false, disconnected: false,
        isBot: false, ready: true, isSelf: false, hand: [], index: 1 }
    ],
    myTurn: false, minRaiseTo: 40, callAmount: 0, log: []
  };

  const tournamentBase = {
    state: 'registering', buyIn: 100, startingChips: 1000, maxPlayers: 7,
    prizePool: 0, level: 1, sb: 10, bb: 20, ante: 0,
    levelEndsAt: null, pendingLevel: false, nextLevel: { sb: 15, bb: 30, ante: 0 },
    entrants: [
      { playerId: 'p1', name: 'Alice', place: null, payout: 0, eliminated: false, chips: 1000 },
      { playerId: 'p2', name: 'Bob', place: null, payout: 0, eliminated: false, chips: 1000 }
    ],
    payoutStructure: [{ place: 1, percent: 50 }, { place: 2, percent: 30 }, { place: 3, percent: 20 }],
    playerCount: 2, aliveCount: 2, handCount: 0, startedAt: null, finishedAt: null
  };

  fire('joined', { playerId: 'p1', roomId: 't', token: 'k' });

  // 报名中
  assert.doesNotThrow(() => fire('state', {
    ...base, tournament: tournamentBase
  }), '报名中渲染失败');

  // 进行中
  assert.doesNotThrow(() => fire('state', {
    ...base,
    stage: 'preflop',
    tournament: {
      ...tournamentBase,
      state: 'running',
      prizePool: 200,
      levelEndsAt: Date.now() + 300000,
      startedAt: Date.now() - 1000
    }
  }), '进行中渲染失败');

  // 结束
  assert.doesNotThrow(() => fire('state', {
    ...base,
    stage: 'ended',
    tournament: {
      ...tournamentBase,
      state: 'finished',
      prizePool: 200,
      aliveCount: 1,
      startedAt: Date.now() - 60000,
      finishedAt: Date.now(),
      entrants: [
        { playerId: 'p1', name: 'Alice', place: 1, payout: 130, eliminated: false, chips: 2000 },
        { playerId: 'p2', name: 'Bob', place: 2, payout: 70, eliminated: true, chips: 0 }
      ]
    }
  }), '结束渲染失败');
});

test('5.3 锦标赛淘汰事件不抛异常', () => {
  const { context, handlers } = buildSandbox();
  vm.runInContext(soundJs, context, { filename: 'sound.js' });
  vm.runInContext(clientJs, context, { filename: 'client.js' });

  const fire = (ev, payload) => { for (const fn of handlers[ev] || []) fn(payload); };
  assert.doesNotThrow(() => fire('tournament:eliminated', { name: 'Bob', place: 2 }));
  assert.doesNotThrow(() => fire('tournament:level', { level: 2, sb: 15, bb: 30, ante: 0 }));
});

test('5.3 锦标赛快照不泄露底牌', () => {
  // 服务端 contract：tournament 对象里不应有 hand/holeCards 字段
  const { Tournament } = require('../game/tournament');
  const t = new Tournament({ buyIn: 100 });
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start();
  const json = JSON.stringify(t.toPublicState());
  assert.ok(!json.includes('"hand"'));
  assert.ok(!json.includes('"holeCards"'));
});
