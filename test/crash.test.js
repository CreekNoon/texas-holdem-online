const test = require('node:test');
const assert = require('node:assert');
const { startServer, joinRoom, sleep, connectNative } = require('../test-support/serverHarness');

test('3.8 join/action/chat 传非法载荷，服务进程不退出', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const socket = await connectNative(`http://127.0.0.1:${s.port}`);
  assert.ok(socket.connected);

  for (const payload of [undefined, null, 'not-an-object', 123, []]) {
    socket.emit('join', payload);
  }
  await sleep(300);
  assert.strictEqual(s.child.exitCode, null, 'join 非法载荷不应导致进程退出');

  for (const payload of [undefined, null, 'check', { action: 'raise', amount: NaN }]) {
    socket.emit('action', payload);
  }
  await sleep(300);
  assert.strictEqual(s.child.exitCode, null, 'action 非法载荷不应导致进程退出');

  for (const payload of [undefined, null, 123, { text: 'x' }]) {
    socket.emit('chat', payload);
  }
  await sleep(300);
  assert.strictEqual(s.child.exitCode, null, 'chat 非法载荷不应导致进程退出');

  socket.disconnect();
});

test('3.4 房间删除后再 chat，服务进程不退出', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const { socket } = await joinRoom(s.port, 'solo', 'D');
  await sleep(150);

  socket.emit('leave');
  await sleep(250);

  socket.emit('chat', 'hello after leave');
  await sleep(400);

  assert.strictEqual(s.child.exitCode, null, '房间删除后 chat 不应导致进程退出');
  socket.disconnect();
});

test('3.2 牌局中 join 被拒绝', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'room1', 'A');
  const b = await joinRoom(s.port, 'room1', 'B');
  await sleep(150);

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(
    st => ['preflop', 'flop', 'turn', 'river'].includes(st.stage),
    3000
  );
  assert.ok(started, '牌局应已开始');

  const c = await connectNative(`http://127.0.0.1:${s.port}`);
  c.emit('join', { roomId: 'room1', name: 'C' });
  const err = await c.once('error');
  assert.ok(err, '牌局中 join 应返回错误');
  assert.strictEqual(s.child.exitCode, null);

  c.disconnect();
  a.socket.disconnect();
  b.socket.disconnect();
});

test('3.4 constructor 房间号不崩溃且可正常使用', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const { socket, joined } = await joinRoom(s.port, 'constructor', 'A');
  assert.ok(joined);
  const state = await socket.once('state');
  assert.strictEqual(state.roomId, 'constructor');
  assert.strictEqual(s.child.exitCode, null);

  socket.disconnect();
});

test('3.4 __proto__ 房间号不崩溃', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const { socket, joined } = await joinRoom(s.port, '__proto__', 'A');
  assert.ok(joined);
  const state = await socket.once('state');
  assert.strictEqual(state.roomId, '__proto__');
  assert.strictEqual(s.child.exitCode, null);

  socket.disconnect();
});

test('3.2 同一 socket 重复 join 只占一个座位', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const { socket } = await joinRoom(s.port, 'dup', 'A');
  await sleep(150);

  socket.emit('join', { roomId: 'dup', name: 'A2' });
  await sleep(250);
  const state = await socket.once('state');
  assert.strictEqual(state.players.length, 1, '重复 join 不应产生第二个座位');
  assert.strictEqual(s.child.exitCode, null);

  socket.disconnect();
});

test('3.2 跨房间 join 后 leave 不残留幽灵玩家', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const b = await connectNative(`http://127.0.0.1:${s.port}`);
  b.emit('join', { roomId: 'roomX', name: 'X' });
  await b.once('joined');
  await sleep(150);

  b.emit('join', { roomId: 'roomY', name: 'Y' });
  await b.once('joined');
  await sleep(150);

  b.emit('leave');
  await sleep(250);
  b.disconnect();
  await sleep(150);

  const { socket: probe } = await joinRoom(s.port, 'roomX', 'probe');
  const state = await probe.once('state');
  const names = state.players.map(p => p.name);
  assert.ok(!names.includes('X'), 'roomX 不应残留已离开的 X');
  assert.strictEqual(s.child.exitCode, null);

  probe.disconnect();
});

test('3.4 非法房间号被拒绝', async (t) => {
  const s = await startServer();
  t.after(() => s.stop());

  const socket = await connectNative(`http://127.0.0.1:${s.port}`);

  for (const roomId of ['a b', 'a/b', 'a'.repeat(21), '../etc', '']) {
    socket.emit('join', { roomId, name: 'A' });
    const msg = await socket.once('error', 1200);
    assert.ok(msg, `非法房间号 ${JSON.stringify(roomId)} 应被拒绝`);
  }
  assert.strictEqual(s.child.exitCode, null);

  socket.disconnect();
});
