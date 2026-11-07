const test = require('node:test');
const assert = require('node:assert');
const { startServer, joinRoom, sleep } = require('../test-support/serverHarness');

const FAST_BOTS = {
  BOT_MIN_DELAY_MS: '15',
  BOT_MAX_DELAY_MS: '40',
  TURN_TIME_MS: '3000',
  EQUITY_ITERATIONS: '500'
};

test('4.3 训练模式：单人 + 3 机器人可打完 2 局且筹码守恒', { timeout: 120000 }, async (t) => {
  const s = await startServer(FAST_BOTS);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'train1', 'Human');
  await sleep(120);

  // 先挂常驻监听，确保后续所有 state 都能拿到
  let state = null;
  a.socket.on('state', (st) => { state = st; });

  a.socket.emit('room:configure', { mode: 'training', botCount: 4, botDifficulty: 'normal' });
  const configured = await a.socket.waitForState(x => x.players.length === 4, 3000);
  assert.ok(configured, '应补足到 4 人');
  assert.strictEqual(configured.players.filter(p => p.isBot).length, 3, '应有 3 个机器人');

  a.socket.drainQueue('state');
  a.socket.emit('start');
  await sleep(250);

  let hands = 0;
  let lastEndedHand = 0; // 已处理过的 ended 局号
  let lastStartRequestAt = 0;
  const deadline = Date.now() + 60000;

  while (Date.now() < deadline && hands < 2) {
    if (!state) { await sleep(50); continue; }

    if (state.stage === 'ended') {
      if (state.handCount !== lastEndedHand) {
        hands++;
        lastEndedHand = state.handCount;
        const sum = state.players.reduce((x, p) => x + p.chips, 0);
        assert.strictEqual(sum, 4000, `第 ${hands} 局后筹码应守恒 4000，实际 ${sum}`);
        if (hands >= 2) break;
        lastStartRequestAt = 0; // 允许为新一局发 start
      }
      // 未进入下一局时定期重试 start（防止单次 start 丢失）
      if (hands < 2 && Date.now() - lastStartRequestAt > 500) {
        lastStartRequestAt = Date.now();
        a.socket.emit('start');
      }
      await sleep(120);
      continue;
    }

    const cur = state.players[state.currentPlayerIndex];
    if (cur && cur.isSelf) {
      const call = Math.max(0, state.currentBet - cur.currentBet);
      a.socket.emit('action', { action: call === 0 ? 'check' : 'call', amount: 0 });
    }
    await sleep(60);
  }

  assert.strictEqual(hands, 2, `应打完 2 局，实际 ${hands}`);
  assert.strictEqual(s.child.exitCode, null, '服务应存活');

  a.socket.disconnect();
});

test('4.1 机器人从不执行非法动作，牌局不卡死', async (t) => {
  const s = await startServer(FAST_BOTS);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'hang', 'Human');
  await sleep(120);
  a.socket.emit('room:configure', { mode: 'training', botCount: 4 });
  await a.socket.waitForState(x => x.players.length === 4, 3000);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(x => x.stage === 'preflop', 3000);
  assert.ok(started);

  // 人类完全不动，让机器人 + 超时把牌局推完
  const ended = await a.socket.waitForState(x => x.stage === 'ended', 20000);
  assert.ok(ended, '即使人类挂机，牌局也应结束（机器人推进 + 超时）');

  a.socket.disconnect();
});

test('3.3 胜率查询只返回自己的底牌相关结果', async (t) => {
  const s = await startServer({ ...FAST_BOTS, BOT_MIN_DELAY_MS: '3000', BOT_MAX_DELAY_MS: '4000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'eq1', 'Human');
  await sleep(120);
  a.socket.emit('room:configure', { mode: 'training', botCount: 3 });
  await a.socket.waitForState(x => x.players.length === 3, 3000);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  await a.socket.waitForState(x => x.stage === 'preflop', 3000);

  a.socket.emit('equity:request', {});
  const result = await a.socket.once('equity:result', 5000);

  assert.ok(result, '应收到 equity:result');
  assert.strictEqual(result.error, undefined, `不应报错: ${result.error}`);
  assert.ok(result.equity >= 0 && result.equity <= 1, `equity 应在 0–1，实际 ${result.equity}`);
  assert.ok(result.iterations > 0);
  // 结果里不能包含任何他人底牌
  assert.strictEqual(result.hole, undefined);
  assert.strictEqual(result.opponentHands, undefined);

  a.socket.disconnect();
});

test('3.3 胜率请求限流：1 秒内第二次被拒', async (t) => {
  const s = await startServer({ ...FAST_BOTS, BOT_MIN_DELAY_MS: '3000', BOT_MAX_DELAY_MS: '4000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'eq2', 'Human');
  await sleep(120);
  a.socket.emit('room:configure', { mode: 'training', botCount: 3 });
  await a.socket.waitForState(x => x.players.length === 3, 3000);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  await a.socket.waitForState(x => x.stage === 'preflop', 3000);

  a.socket.emit('equity:request', {});
  const first = await a.socket.once('equity:result', 5000);
  assert.ok(first && !first.error);

  a.socket.emit('equity:request', {});
  const second = await a.socket.once('equity:result', 2000);
  assert.ok(second && second.error, '第二次请求应被限流');

  // 等过 1 秒后应恢复
  await sleep(1100);
  a.socket.emit('equity:request', {});
  const third = await a.socket.once('equity:result', 5000);
  assert.ok(third && !third.error, '1 秒后应可再次请求');
  assert.strictEqual(third.cached, true, '相同局面应命中缓存');

  a.socket.disconnect();
});

test('3.3 牌局未开始时胜率请求被拒', async (t) => {
  const s = await startServer(FAST_BOTS);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'eq3', 'Human');
  await sleep(150);

  a.socket.emit('equity:request', {});
  const result = await a.socket.once('equity:result', 3000);
  assert.ok(result && result.error, '未开局时应返回错误');

  a.socket.disconnect();
});

test('4.3 训练模式重置筹码', async (t) => {
  const s = await startServer(FAST_BOTS);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'reset', 'Human');
  await sleep(120);
  a.socket.emit('room:configure', { mode: 'training', botCount: 3 });
  await a.socket.waitForState(x => x.players.length === 3, 3000);

  a.socket.drainQueue('state');
  a.socket.emit('training:reset', { chips: 500 });
  const state = await a.socket.waitForState(x => x.players.every(p => p.chips === 500), 3000);
  assert.ok(state, '重置后所有人筹码应为 500');

  a.socket.disconnect();
});

test('4.3 非法难度被拒绝', async (t) => {
  const s = await startServer(FAST_BOTS);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'diff', 'Human');
  await sleep(150);

  a.socket.emit('room:configure', { botDifficulty: 'impossible' });
  const err = await a.socket.once('error', 2000);
  assert.ok(err, '非法难度应被拒绝');

  a.socket.disconnect();
});
