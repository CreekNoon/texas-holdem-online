const test = require('node:test');
const assert = require('node:assert');
const { startServer, joinRoom, sleep, connectNative } = require('../test-support/serverHarness');

const FAST = { TURN_TIME_MS: '4000', BOT_MIN_DELAY_MS: '15', BOT_MAX_DELAY_MS: '40' };

// ===== 房主 =====

test('3.2 首个加入者成为房主', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'host1', 'Alice');
  const b = await joinRoom(s.port, 'host1', 'Bob');
  await sleep(200);

  const st = await b.socket.waitForState(x => x.players.length === 2, 3000);
  assert.ok(st.hostId, '应有 hostId');
  assert.strictEqual(st.isHost, false, 'B 不是房主');

  const stA = await a.socket.waitForState(x => x.players.length === 2, 3000);
  assert.strictEqual(stA.isHost, true, 'A 应是房主');

  a.socket.disconnect();
  b.socket.disconnect();
});

test('3.2 非房主无法开局', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'host2', 'Alice');
  const b = await joinRoom(s.port, 'host2', 'Bob');
  await sleep(200);

  b.socket.emit('start');
  const err = await b.socket.once('error', 2000);
  assert.ok(err && err.includes('房主'), `应提示等待房主，实际: ${err}`);

  a.socket.disconnect();
  b.socket.disconnect();
});

test('3.2 房主离开后顺延给下一位在线玩家', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'host3', 'Alice');
  const b = await joinRoom(s.port, 'host3', 'Bob');
  await sleep(200);

  a.socket.emit('leave');
  await sleep(300);

  const st = await b.socket.waitForState(x => x.isHost === true, 3000);
  assert.ok(st, 'B 应继承房主');

  b.socket.disconnect();
});

// ===== 准备机制 =====

test('3.2 开启 requireReady 后未准备无法开局', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'ready1', 'Alice');
  const b = await joinRoom(s.port, 'ready1', 'Bob');
  await sleep(200);

  a.socket.emit('host:config', { requireReady: true });
  const cfg = await a.socket.waitForState(x => x.requireReady === true, 3000);
  assert.ok(cfg, 'requireReady 应开启');

  a.socket.emit('start');
  const err = await a.socket.once('error', 2000);
  assert.ok(err && err.includes('未准备'), `应提示未准备，实际: ${err}`);

  a.socket.disconnect();
  b.socket.disconnect();
});

test('3.2 全员准备后房主可开局', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'ready2', 'Alice');
  const b = await joinRoom(s.port, 'ready2', 'Bob');
  await sleep(200);

  a.socket.emit('host:config', { requireReady: true });
  await a.socket.waitForState(x => x.requireReady === true, 3000);

  a.socket.emit('ready', { ready: true });
  b.socket.emit('ready', { ready: true });
  await sleep(250);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(x => x.stage === 'preflop', 3000);
  assert.ok(started, '全员准备后应能开局');

  a.socket.disconnect();
  b.socket.disconnect();
});

test('3.2 ready 状态可切换', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'ready3', 'Alice');
  await sleep(150);

  a.socket.emit('ready', { ready: true });
  const r1 = await a.socket.waitForState(x => x.readyIds.length === 1, 2000);
  assert.ok(r1, '应变为已准备');

  a.socket.emit('ready', { ready: false });
  const r2 = await a.socket.waitForState(x => x.readyIds.length === 0, 2000);
  assert.ok(r2, '应取消准备');

  a.socket.disconnect();
});

test('3.2 非房主不能改配置', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'cfg1', 'Alice');
  const b = await joinRoom(s.port, 'cfg1', 'Bob');
  await sleep(200);

  b.socket.emit('host:config', { requireReady: true });
  const err = await b.socket.once('error', 2000);
  assert.ok(err && err.includes('房主'), `非房主改配置应被拒，实际: ${err}`);

  a.socket.disconnect();
  b.socket.disconnect();
});

test('3.2 牌局中不能改配置', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'cfg2', 'Alice');
  const b = await joinRoom(s.port, 'cfg2', 'Bob');
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  await a.socket.waitForState(x => x.stage === 'preflop', 3000);

  a.socket.emit('host:config', { smallBlind: 50 });
  const err = await a.socket.once('error', 2000);
  assert.ok(err && err.includes('进行中'), `牌局中改配置应被拒，实际: ${err}`);

  a.socket.disconnect();
  b.socket.disconnect();
});

// ===== 观战 =====

test('3.3 观战者不占座位', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'spec1', 'Alice');
  await sleep(150);

  const spec = await connectNative(`http://127.0.0.1:${s.port}`);
  spec.emit('join', { roomId: 'spec1', name: 'Watcher', spectate: true });
  const joined = await spec.once('joined', 3000);
  assert.ok(joined && joined.spectator, '应以观战身份加入');

  const st = await a.socket.waitForState(x => x.spectatorCount === 1, 3000);
  assert.ok(st, '房内应看到 1 名观战者');
  assert.strictEqual(st.players.length, 1, '观战者不占座位');

  a.socket.disconnect();
  spec.disconnect();
});

test('3.3 观战者不能行动也不能开局', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'spec2', 'Alice');
  await sleep(150);

  const spec = await connectNative(`http://127.0.0.1:${s.port}`);
  spec.emit('join', { roomId: 'spec2', name: 'Watcher', spectate: true });
  await spec.once('joined', 3000);

  spec.emit('start');
  const err1 = await spec.once('error', 2000);
  assert.ok(err1 && err1.includes('观战'), `观战者开局应被拒，实际: ${err1}`);

  spec.emit('action', { action: 'check', amount: 0 });
  const err2 = await spec.once('error', 2000);
  assert.ok(err2, '观战者行动应被拒');

  a.socket.disconnect();
  spec.disconnect();
});

test('3.3 观战者默认看不到底牌', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'spec3', 'Alice');
  const b = await joinRoom(s.port, 'spec3', 'Bob');
  await sleep(200);

  const spec = await connectNative(`http://127.0.0.1:${s.port}`);
  spec.emit('join', { roomId: 'spec3', name: 'Watcher', spectate: true });
  await spec.once('joined', 3000);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  await a.socket.waitForState(x => x.stage === 'preflop', 3000);

  const specState = await spec.waitForState(x => x.stage === 'preflop', 3000);
  assert.ok(specState, '观战者应收到状态');
  assert.strictEqual(specState.spectator, true);
  for (const p of specState.players) {
    assert.deepStrictEqual(p.hand, [], `${p.name} 的底牌对观战者不可见`);
  }

  a.socket.disconnect();
  b.socket.disconnect();
  spec.disconnect();
});

test('3.3 房主开启 spectatorSeeAll 后观战者可在摊牌时看到底牌', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'spec4', 'Alice');
  const b = await joinRoom(s.port, 'spec4', 'Bob');
  await sleep(200);

  const spec = await connectNative(`http://127.0.0.1:${s.port}`);
  spec.emit('join', { roomId: 'spec4', name: 'Watcher', spectate: true });
  await spec.once('joined', 3000);

  a.socket.emit('host:config', { spectatorSeeAll: true });
  await sleep(200);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const st = await a.socket.waitForState(x => x.stage === 'preflop', 3000);
  assert.ok(st);

  // 未摊牌时观战者仍看不到底牌
  const pre = await spec.waitForState(x => x.stage === 'preflop', 3000);
  assert.ok(pre.players.every(p => p.hand.length === 0), '未摊牌时观战者仍看不到底牌');

  a.socket.disconnect();
  b.socket.disconnect();
  spec.disconnect();
});

test('3.3 观战者离开不释放座位', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'spec5', 'Alice');
  await sleep(150);

  const spec = await connectNative(`http://127.0.0.1:${s.port}`);
  spec.emit('join', { roomId: 'spec5', name: 'Watcher', spectate: true });
  await spec.once('joined', 3000);
  await sleep(150);

  spec.emit('leave');
  await sleep(250);

  const st = await a.socket.waitForState(x => x.spectatorCount === 0, 3000);
  assert.ok(st, '观战者应被移除');
  assert.strictEqual(st.players.length, 1, '座位不受影响');

  a.socket.disconnect();
});
