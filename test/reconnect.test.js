const test = require('node:test');
const assert = require('node:assert');
const { startServer, joinRoom, sleep, connectNative } = require('../test-support/serverHarness');

// 测试 1：断线重连恢复座位/筹码/底牌，且不重复占座
test('2.1 断线后带 token 重连，座位/筹码/底牌不变', async (t) => {
  const s = await startServer({ TURN_TIME_MS: '60000', RECONNECT_GRACE_MS: '120000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'rc', 'Alice');
  const b = await joinRoom(s.port, 'rc', 'Bob');
  await sleep(200);

  // 开始牌局，A 拿到手牌
  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(st => st.stage === 'preflop', 3000);
  assert.ok(started, '牌局应开始');

  const aPlayer = started.players.find(p => p.isSelf);
  const aChips = aPlayer.chips;
  const aHand = aPlayer.hand.slice();
  const aSeat = aPlayer.index;
  assert.strictEqual(aHand.length, 2, 'A 应有 2 张底牌');

  // 断线
  a.socket.disconnect();
  await sleep(300);

  // 带 token 重连
  const c = await connectNative(`http://127.0.0.1:${s.port}`);
  c.emit('join', { roomId: 'rc', name: 'Alice', playerId: a.joined.playerId, token: a.joined.token });
  const rejoined = await c.once('joined');
  assert.ok(rejoined, '应重连成功');
  assert.strictEqual(rejoined.reconnected, true, '应标记为重连');
  assert.ok(rejoined.token, '重连后应返回新 token');
  assert.notStrictEqual(rejoined.token, a.joined.token, 'token 应轮换');

  const restored = await c.waitForState(st => st.stage === 'preflop', 3000);
  const me = restored.players.find(p => p.isSelf);
  assert.strictEqual(me.chips, aChips, '筹码应恢复');
  assert.strictEqual(me.index, aSeat, '座位应恢复');
  assert.deepStrictEqual(me.hand, aHand, '底牌应恢复');
  assert.strictEqual(restored.players.length, 2, '不应重复占座');

  c.disconnect();
  b.socket.disconnect();
});

// 测试 2：错误 token 被拒绝
test('2.2 错误 token 重连被拒绝', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'bad', 'Alice');
  await sleep(150);

  const c = await connectNative(`http://127.0.0.1:${s.port}`);
  c.emit('join', {
    roomId: 'bad',
    name: 'Alice',
    playerId: a.joined.playerId,
    token: 'deadbeef'.repeat(4)
  });
  const err = await c.once('error');
  assert.ok(err, '错误 token 应被拒绝');

  c.disconnect();
  a.socket.disconnect();
});

// 测试 3：同 playerId 双开，旧连接被踢
test('2.3 同一身份双开，旧连接被踢出', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'dup', 'Alice');
  await sleep(150);

  const replacedPromise = a.socket.once('session:replaced', 3000);

  const b = await connectNative(`http://127.0.0.1:${s.port}`);
  b.emit('join', {
    roomId: 'dup',
    name: 'Alice',
    playerId: a.joined.playerId,
    token: a.joined.token
  });
  const rejoined = await b.once('joined');
  assert.ok(rejoined, '新连接应接管成功');

  const replaced = await replacedPromise;
  assert.ok(replaced, '旧连接应收到 session:replaced');
  await sleep(300);
  assert.strictEqual(a.socket.connected, false, '旧连接应被断开');

  b.disconnect();
});

// 竞态防护：旧连接被踢后的 disconnect 不能把新连接标记为离线
test('2.4 会话被接管后，旧连接的 disconnect 不影响新连接', async (t) => {
  const s = await startServer({ RECONNECT_GRACE_MS: '400' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'race', 'Alice');
  const b = await joinRoom(s.port, 'race', 'Bob');
  await sleep(150);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  await a.socket.waitForState(st => st.stage === 'preflop', 3000);

  // A 仍在线时，新连接直接接管（旧 socket 会被踢）
  const a2 = await connectNative(`http://127.0.0.1:${s.port}`);
  a2.emit('join', {
    roomId: 'race',
    name: 'Alice',
    playerId: a.joined.playerId,
    token: a.joined.token
  });
  const rejoined = await a2.once('joined');
  assert.ok(rejoined, '接管应成功');

  // 等过宽限期：若旧 socket 的 disconnect 误伤了新连接，这里会看到离线/弃牌
  await sleep(700);
  const st = await b.socket.waitForState(x => x.stage === 'preflop', 2000);
  const alice = st && st.players.find(p => p.name === 'Alice');
  assert.ok(alice, 'Alice 应仍在座位上');
  assert.strictEqual(alice.disconnected, false, '新连接不应被标记离线');
  assert.strictEqual(alice.folded, false, '新连接不应被弃牌');

  // 新连接仍能正常行动
  a2.emit('action', { action: 'call', amount: 0 });
  const err = await a2.once('error', 1500);
  assert.strictEqual(err, null, '新连接应能正常行动');

  a2.disconnect();
  b.socket.disconnect();
});

// 测试 6：宽限期结束，断线玩家被弃牌
test('2.6 宽限期结束后断线玩家被弃牌', async (t) => {
  const s = await startServer({ RECONNECT_GRACE_MS: '300', TURN_TIME_MS: '60000' });
  t.after(() => s.stop());

  // 用 3 人局：单挑时一人弃牌会立刻结束本局，看不到 folded 状态
  const a = await joinRoom(s.port, 'grace', 'Alice');
  const b = await joinRoom(s.port, 'grace', 'Bob');
  const c = await joinRoom(s.port, 'grace', 'Carol');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(st => st.stage === 'preflop', 3000);
  assert.ok(started, '牌局应开始');

  // A 断线
  a.socket.disconnect();
  await sleep(150);

  const afterDisc = await b.socket.waitForState(
    st => st.stage === 'preflop' && st.players.some(p => p.name === 'Alice' && p.disconnected),
    3000
  );
  assert.ok(afterDisc, '应看到 A 被标记离线且仍保留座位');

  // 等待宽限期（300ms）到期
  const afterGrace = await b.socket.waitForState(
    st => st.stage === 'preflop' && st.players.some(p => p.name === 'Alice' && p.folded),
    3000
  );
  assert.ok(afterGrace, '宽限期结束后 A 应被弃牌且座位仍保留到本局结束');
  assert.strictEqual(s.child.exitCode, null);

  b.socket.disconnect();
  c.socket.disconnect();
});

test('2.6 宽限期结束且不在牌局时，座位被释放', async (t) => {
  const s = await startServer({ RECONNECT_GRACE_MS: '300' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'idle', 'Alice');
  const b = await joinRoom(s.port, 'idle', 'Bob');
  await sleep(200);

  a.socket.disconnect();
  await sleep(150);
  assert.strictEqual(s.child.exitCode, null);

  // waiting 阶段：宽限期后直接移除
  await sleep(500);
  const state = await b.socket.waitForState(
    st => !st.players.some(p => p.name === 'Alice'),
    3000
  );
  assert.ok(state, 'waiting 阶段宽限期后座位应被释放');

  b.socket.disconnect();
});

// 重连不重置筹码：断线期间盲注照扣
test('2.3 重连不重置筹码与下注状态', async (t) => {
  const s = await startServer({ TURN_TIME_MS: '60000', RECONNECT_GRACE_MS: '120000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'keep', 'Alice');
  const b = await joinRoom(s.port, 'keep', 'Bob');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(st => st.stage === 'preflop', 3000);
  const before = started.players.find(p => p.isSelf);

  a.socket.disconnect();
  await sleep(250);

  const c = await connectNative(`http://127.0.0.1:${s.port}`);
  c.emit('join', {
    roomId: 'keep',
    name: 'Alice',
    playerId: a.joined.playerId,
    token: a.joined.token
  });
  await c.once('joined');
  const after = await c.waitForState(st => st.stage === 'preflop', 3000);
  const me = after.players.find(p => p.isSelf);

  assert.strictEqual(me.chips, before.chips, '重连不应重置筹码');
  assert.strictEqual(me.totalBet, before.totalBet, '重连不应重置下注');
  assert.strictEqual(me.currentBet, before.currentBet, '重连不应重置本轮下注');

  c.disconnect();
  b.socket.disconnect();
});
