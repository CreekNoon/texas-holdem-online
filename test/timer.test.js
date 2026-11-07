const test = require('node:test');
const assert = require('node:assert');
const { startServer, joinRoom, sleep } = require('../test-support/serverHarness');

// 测试 4：轮到某人挂机 → 超时后牌局继续
test('2.4 挂机超时后自动弃牌，牌局继续', async (t) => {
  const s = await startServer({ TURN_TIME_MS: '200' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'to1', 'Alice');
  const b = await joinRoom(s.port, 'to1', 'Bob');
  const c = await joinRoom(s.port, 'to1', 'Carol');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(st => st.stage === 'preflop', 3000);
  assert.ok(started, '牌局应开始');

  // 谁都不行动，等待超时自动推进
  const advanced = await a.socket.waitForState(
    st => st.stage !== 'preflop' || st.currentPlayerIndex !== started.currentPlayerIndex,
    3000
  );
  assert.ok(advanced, '超时后应自动行动并推进');

  // 日志中应有超时记录
  const withTimeoutLog = await a.socket.waitForState(
    st => st.log.some(line => line.includes('行动超时')),
    3000
  );
  assert.ok(withTimeoutLog, '超时动作应写入日志');

  a.socket.disconnect();
  b.socket.disconnect();
  c.socket.disconnect();
});

// 测试 5：callAmount === 0 时超时应 check 而不是 fold
test('2.5 超时且无需跟注时自动过牌', async (t) => {
  const s = await startServer({ TURN_TIME_MS: '150' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'to2', 'Alice');
  const b = await joinRoom(s.port, 'to2', 'Bob');
  const c = await joinRoom(s.port, 'to2', 'Carol');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');

  // 让所有人跟注/过牌到翻牌，翻牌后首位行动者 callAmount 为 0
  let guard = 0;
  let state = await a.socket.waitForState(st => st.stage === 'preflop', 3000);
  while (state && state.stage === 'preflop' && guard++ < 20) {
    const cur = state.players[state.currentPlayerIndex];
    if (!cur) break;
    const call = Math.max(0, state.currentBet - cur.currentBet);
    const sock = cur.isSelf ? a.socket : (state.players.find(p => p.isSelf) && cur.name === 'Bob' ? b.socket : c.socket);
    sock.emit('action', { action: call === 0 ? 'check' : 'call', amount: 0 });
    await sleep(80);
    state = await a.socket.waitForState(st => st.stage !== 'preflop' || st.currentPlayerIndex !== state.currentPlayerIndex, 2000);
    if (state && state.stage !== 'preflop') break;
  }

  const flop = await a.socket.waitForState(st => st.stage === 'flop', 3000);
  assert.ok(flop, '应进入翻牌');

  const before = flop.players[flop.currentPlayerIndex].name;
  const afterTimeout = await a.socket.waitForState(
    st => st.log.some(line => line.includes('自动过牌')),
    3000
  );
  assert.ok(afterTimeout, '无需跟注时应自动过牌而不是弃牌');
  assert.ok(!afterTimeout.log.some(l => l.includes(`${before} 行动超时，自动弃牌`)), '不应自动弃牌');

  a.socket.disconnect();
  b.socket.disconnect();
  c.socket.disconnect();
});

// 测试 7：showdown/ended 不启动计时器
test('2.7 结算/结束阶段不启动计时器', async (t) => {
  const s = await startServer({ TURN_TIME_MS: '60000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'to3', 'Alice');
  const b = await joinRoom(s.port, 'to3', 'Bob');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const st0 = await a.socket.waitForState(st => st.stage === 'preflop', 3000);
  assert.ok(st0, '牌局应开始');

  // 当前行动者全押
  const actorIsA = st0.players[st0.currentPlayerIndex].isSelf;
  (actorIsA ? a.socket : b.socket).emit('action', { action: 'allin', amount: 0 });

  // 另一方跟注
  const st1 = await a.socket.waitForState(
    st => st.stage === 'preflop' && st.players.some(p => p.allIn),
    3000
  );
  assert.ok(st1, '全押应生效');
  const cur = st1.players[st1.currentPlayerIndex];
  const call = Math.max(0, st1.currentBet - cur.currentBet);
  (cur.isSelf ? a.socket : b.socket).emit('action', { action: call === 0 ? 'check' : 'call', amount: 0 });

  const ended = await a.socket.waitForState(st => st.stage === 'ended', 5000);
  assert.ok(ended, '双方 all-in 后应走到结束');
  assert.strictEqual(ended.turnDeadline, null, 'ended 阶段不应有 turnDeadline');

  // 结束后不应再被超时计时器改动：400ms 内不应出现任何非 ended 的新状态
  const changed = await a.socket.waitForState(st => st.stage !== 'ended', 600);
  assert.strictEqual(changed, null, '结束后不应被计时器改动状态');

  a.socket.disconnect();
  b.socket.disconnect();
});

// 状态协议：turnDeadline / turnTimeMs 下发
test('2.4 getPublicState 下发 turnDeadline 与 turnTimeMs', async (t) => {
  const s = await startServer({ TURN_TIME_MS: '60000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'to4', 'Alice');
  const b = await joinRoom(s.port, 'to4', 'Bob');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const state = await a.socket.waitForState(st => st.stage === 'preflop', 3000);

  assert.ok(state, '牌局应开始');
  assert.strictEqual(state.turnTimeMs, 60000, 'turnTimeMs 应下发');
  assert.ok(typeof state.turnDeadline === 'number', 'turnDeadline 应为时间戳');
  assert.ok(state.turnDeadline > Date.now(), 'deadline 应在未来');
  assert.ok(state.turnDeadline - Date.now() <= 60000, 'deadline 不应超过配置时长');

  a.socket.disconnect();
  b.socket.disconnect();
});

// 别人 join/chat 不应给当前玩家续时
test('2.4 其他玩家聊天不会重置当前回合计时器', async (t) => {
  const s = await startServer({ TURN_TIME_MS: '1000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'to5', 'Alice');
  const b = await joinRoom(s.port, 'to5', 'Bob');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const first = await a.socket.waitForState(st => st.stage === 'preflop', 3000);
  const deadline1 = first.turnDeadline;

  // B 连续聊天，不应延长 A 的回合
  for (let i = 0; i < 5; i++) {
    b.socket.emit('chat', `spam ${i}`);
    await sleep(100);
  }

  const after = await a.socket.waitForState(st => st.stage === 'preflop', 1000);
  if (after) {
    assert.strictEqual(after.turnDeadline, deadline1, '聊天不应改变 turnDeadline');
  }

  a.socket.disconnect();
  b.socket.disconnect();
});
