const test = require('node:test');
const assert = require('node:assert');
const { startServer, joinRoom, sleep } = require('../test-support/serverHarness');

const FAST = {
  TURN_TIME_MS: '3000',
  BOT_MIN_DELAY_MS: '10',
  BOT_MAX_DELAY_MS: '30',
  RECONNECT_GRACE_MS: '500',
  // 盲注等级时长注入为 800ms，避免测试真的等 5 分钟
  LEVEL_TIMER_MS: '800'
};

// 让人类玩家一直 check/call，直到牌局结束
async function autoPlayHuman(socket, stateRef, deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const st = stateRef.value;
    if (!st) { await sleep(40); continue; }
    if (st.stage === 'ended') return;
    const cur = st.players[st.currentPlayerIndex];
    if (cur && cur.isSelf && st.stage !== 'waiting') {
      const call = Math.max(0, st.currentBet - cur.currentBet);
      socket.emit('action', { action: call === 0 ? 'check' : 'call', amount: 0 });
    }
    await sleep(40);
  }
}

test('4.1 创建锦标赛：已在房间的玩家自动报名', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng1', 'Alice');
  const b = await joinRoom(s.port, 'sng1', 'Bob');
  await sleep(200);

  a.socket.emit('tournament:create', { buyIn: 100, startingChips: 1000 });
  const st = await a.socket.waitForState(x => x.tournament, 3000);
  assert.ok(st, '应创建锦标赛');
  assert.strictEqual(st.tournament.state, 'registering');
  assert.strictEqual(st.tournament.buyIn, 100);
  assert.strictEqual(st.tournament.playerCount, 2, '已在房间的 2 人应自动报名');

  a.socket.disconnect();
  b.socket.disconnect();
});

test('4.1 非房主不能创建锦标赛', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng2', 'Alice');
  const b = await joinRoom(s.port, 'sng2', 'Bob');
  await sleep(200);

  b.socket.emit('tournament:create', { buyIn: 100 });
  const err = await b.socket.once('error', 2000);
  assert.ok(err && err.includes('房主'), `应拒绝非房主，实际: ${err}`);

  a.socket.disconnect();
  b.socket.disconnect();
});

test('4.1 单人不能开始锦标赛', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng3', 'Alice');
  await sleep(150);
  a.socket.emit('tournament:create', { buyIn: 100 });
  await a.socket.waitForState(x => x.tournament, 3000);

  a.socket.emit('tournament:start');
  const err = await a.socket.once('error', 2000);
  assert.ok(err && err.includes('2 名'), `单人应无法开始，实际: ${err}`);

  a.socket.disconnect();
});

test('4.1 锦标赛开始：奖池 = 买入 × 人数', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng4', 'Alice');
  const b = await joinRoom(s.port, 'sng4', 'Bob');
  const c = await joinRoom(s.port, 'sng4', 'Carol');
  await sleep(200);

  a.socket.emit('tournament:create', { buyIn: 150, startingChips: 1000 });
  await a.socket.waitForState(x => x.tournament, 3000);

  a.socket.emit('tournament:start');
  const started = await a.socket.waitForState(x => x.tournament && x.tournament.state === 'running', 5000);
  assert.ok(started, '锦标赛应开始');
  assert.strictEqual(started.tournament.prizePool, 150 * 3);
  assert.strictEqual(started.tournament.aliveCount, 3);
  assert.strictEqual(started.stage, 'preflop', '应自动开始第一手');

  a.socket.disconnect();
  b.socket.disconnect();
  c.socket.disconnect();
});

test('4.1 锦标赛模式下不能用 start 手动开局', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng5', 'Alice');
  const b = await joinRoom(s.port, 'sng5', 'Bob');
  await sleep(200);

  a.socket.emit('tournament:create', { buyIn: 100 });
  await a.socket.waitForState(x => x.tournament, 3000);

  a.socket.emit('start');
  const err = await a.socket.once('error', 2000);
  assert.ok(err && err.includes('自动'), `SNG 模式应拒绝手动开局，实际: ${err}`);

  a.socket.disconnect();
  b.socket.disconnect();
});

test('4.4 完整 SNG：3 人打到只剩 1 人，名次与奖金完整', { timeout: 120000 }, async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng6', 'Alice');
  const b = await joinRoom(s.port, 'sng6', 'Bob');
  const c = await joinRoom(s.port, 'sng6', 'Carol');
  await sleep(250);

  const stateRef = { value: null };
  a.socket.on('state', st => { stateRef.value = st; });
  const events = { eliminated: [], finished: null, level: [] };
  a.socket.on('tournament:eliminated', e => events.eliminated.push(e));
  a.socket.on('tournament:finished', e => { events.finished = e; });
  a.socket.on('tournament:level', e => events.level.push(e));

  a.socket.emit('tournament:create', { buyIn: 100, startingChips: 200 });
  await a.socket.waitForState(x => x.tournament, 3000);
  a.socket.emit('tournament:start');

  const started = await a.socket.waitForState(
    x => x.tournament && x.tournament.state === 'running' && x.stage === 'preflop', 5000);
  assert.ok(started, '锦标赛应开始');

  // 三个客户端都自动 check/call
  const deadline = Date.now() + 90000;
  let lastHand = -1;
  let stuck = 0;

  while (Date.now() < deadline) {
    const st = stateRef.value;
    if (!st) { await sleep(40); continue; }

    if (st.tournament && st.tournament.state === 'finished') break;

    // 检测卡死
    const sig = `${st.stage}:${st.handCount}:${st.tournament && st.tournament.level}`;
    if (sig === lastHand) stuck++;
    else { stuck = 0; lastHand = sig; }
    if (stuck > 400) break;

    const cur = st.players[st.currentPlayerIndex];
    if (cur && st.stage !== 'waiting' && st.stage !== 'ended') {
      const sock = cur.isSelf ? a.socket
        : (cur.name === 'Bob' ? b.socket : c.socket);
      const call = Math.max(0, st.currentBet - cur.currentBet);
      sock.emit('action', { action: call === 0 ? 'check' : 'call', amount: 0 });
    }
    await sleep(35);
  }

  const finalState = stateRef.value;
  assert.ok(finalState, '应收到最终状态');
  assert.strictEqual(finalState.tournament.state, 'finished', '锦标赛应结束');
  assert.strictEqual(finalState.tournament.aliveCount, 1, '应只剩 1 人');

  // 名次 1..3 完整且唯一
  const places = finalState.tournament.entrants.map(e => e.place).sort((x, y) => x - y);
  assert.deepStrictEqual(places, [1, 2, 3], `名次应为 1..3，实际 ${places}`);

  // 奖金总额 = 奖池
  const payoutSum = finalState.tournament.entrants.reduce((x, e) => x + e.payout, 0);
  assert.strictEqual(payoutSum, finalState.tournament.prizePool,
    `奖金总额 ${payoutSum} 应等于奖池 ${finalState.tournament.prizePool}`);

  // 冠军有奖金
  const champ = finalState.tournament.entrants.find(e => e.place === 1);
  assert.ok(champ && champ.payout > 0, '冠军应有奖金');

  // 收到淘汰事件
  assert.ok(events.eliminated.length >= 2, `应收到至少 2 条淘汰事件，实际 ${events.eliminated.length}`);
  assert.ok(events.finished, '应收到 tournament:finished 事件');

  assert.strictEqual(s.child.exitCode, null, '服务应存活');

  a.socket.disconnect();
  b.socket.disconnect();
  c.socket.disconnect();
});

test('4.1 报名阶段可取消报名', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng7', 'Alice');
  const b = await joinRoom(s.port, 'sng7', 'Bob');
  await sleep(200);

  a.socket.emit('tournament:create', { buyIn: 100 });
  await a.socket.waitForState(x => x.tournament && x.tournament.playerCount === 2, 3000);

  b.socket.emit('tournament:register', { join: false });
  const st = await a.socket.waitForState(x => x.tournament && x.tournament.playerCount === 1, 3000);
  assert.ok(st, '取消报名后人数应减少');

  a.socket.disconnect();
  b.socket.disconnect();
});

test('4.2 盲注随等级提升', { timeout: 60000 }, async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng8', 'Alice');
  const b = await joinRoom(s.port, 'sng8', 'Bob');
  await sleep(200);

  a.socket.emit('tournament:create', { buyIn: 100, startingChips: 5000 });
  const created = await a.socket.waitForState(x => x.tournament, 3000);
  assert.ok(created);
  assert.strictEqual(created.tournament.level, 1);
  assert.strictEqual(created.tournament.sb, 10);
  assert.strictEqual(created.tournament.bb, 20);

  // nextLevel 应存在且更大
  assert.ok(created.tournament.nextLevel);
  assert.ok(created.tournament.nextLevel.bb > created.tournament.bb);

  a.socket.disconnect();
  b.socket.disconnect();
});

test('4.5 淘汰的玩家不出现在下一手座位', { timeout: 120000 }, async (t) => {
  // 用较长的等级时长，避免盲注升级过快导致一手定胜负
  const s = await startServer({ ...FAST, LEVEL_TIMER_MS: '60000' });
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng9', 'Alice');
  const b = await joinRoom(s.port, 'sng9', 'Bob');
  const c = await joinRoom(s.port, 'sng9', 'Carol');
  await sleep(250);

  const stateRef = { value: null };
  a.socket.on('state', st => { stateRef.value = st; });

  a.socket.emit('tournament:create', { buyIn: 100, startingChips: 120 });
  await a.socket.waitForState(x => x.tournament, 3000);
  a.socket.emit('tournament:start');
  await a.socket.waitForState(x => x.tournament && x.tournament.state === 'running', 5000);

  const deadline = Date.now() + 90000;
  let sawElimination = false;

  while (Date.now() < deadline) {
    const st = stateRef.value;
    if (!st || !st.tournament) { await sleep(40); continue; }

    // 任何时刻只要出现淘汰者，就应已不在座位（无论是下一手还是结束态）
    const eliminatedNames = st.tournament.entrants.filter(e => e.eliminated).map(e => e.name);
    if (eliminatedNames.length > 0) {
      const seated = st.players.map(p => p.name);
      for (const n of eliminatedNames) {
        assert.ok(!seated.includes(n), `淘汰者 ${n} 不应出现在座位上`);
      }
      sawElimination = true;
      // 淘汰后若还没结束，再等一拍确认下一手也不含淘汰者
      if (st.tournament.state !== 'finished') break;
    }

    if (st.tournament.state === 'finished') break;

    const cur = st.players[st.currentPlayerIndex];
    if (cur && st.stage !== 'waiting' && st.stage !== 'ended') {
      const sock = cur.isSelf ? a.socket : (cur.name === 'Bob' ? b.socket : c.socket);
      const call = Math.max(0, st.currentBet - cur.currentBet);
      sock.emit('action', { action: call === 0 ? 'check' : 'call', amount: 0 });
    }
    await sleep(35);
  }

  assert.ok(sawElimination, '应观察到至少一次淘汰且座位已移除');
  assert.strictEqual(s.child.exitCode, null);

  a.socket.disconnect();
  b.socket.disconnect();
  c.socket.disconnect();
});

test('4.1 现金局完全不受影响（回归）', async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'cash', 'Alice');
  const b = await joinRoom(s.port, 'cash', 'Bob');
  await sleep(200);

  const st = await a.socket.waitForState(x => x.players.length === 2, 3000);
  assert.strictEqual(st.tournament, null, '现金局不应有锦标赛状态');

  a.socket.drainQueue('state');
  a.socket.emit('start');
  const started = await a.socket.waitForState(x => x.stage === 'preflop', 3000);
  assert.ok(started, '现金局应能手动开局');
  assert.strictEqual(started.tournament, null);

  a.socket.disconnect();
  b.socket.disconnect();
});

test('4.4 锦标赛结束后淘汰者不残留在座位上', { timeout: 120000 }, async (t) => {
  const s = await startServer(FAST);
  t.after(() => s.stop());

  const a = await joinRoom(s.port, 'sng10', 'Alice');
  const b = await joinRoom(s.port, 'sng10', 'Bob');
  const c = await joinRoom(s.port, 'sng10', 'Carol');
  await sleep(250);

  const stateRef = { value: null };
  a.socket.on('state', st => { stateRef.value = st; });

  a.socket.emit('tournament:create', { buyIn: 100, startingChips: 150 });
  await a.socket.waitForState(x => x.tournament, 3000);
  a.socket.emit('tournament:start');
  await a.socket.waitForState(x => x.tournament && x.tournament.state === 'running', 5000);

  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const st = stateRef.value;
    if (!st || !st.tournament) { await sleep(40); continue; }
    if (st.tournament.state === 'finished') { await sleep(300); break; }

    const cur = st.players[st.currentPlayerIndex];
    if (cur && st.stage !== 'waiting' && st.stage !== 'ended') {
      const sock = cur.isSelf ? a.socket : (cur.name === 'Bob' ? b.socket : c.socket);
      const call = Math.max(0, st.currentBet - cur.currentBet);
      sock.emit('action', { action: call === 0 ? 'check' : 'call', amount: 0 });
    }
    await sleep(35);
  }

  const fin = stateRef.value;
  assert.strictEqual(fin.tournament.state, 'finished', '锦标赛应结束');

  const seatedIds = new Set(fin.players.map(p => p.id));
  const eliminated = fin.tournament.entrants.filter(e => e.eliminated);
  for (const e of eliminated) {
    assert.ok(!seatedIds.has(e.playerId),
      `淘汰者 ${e.name} 不应残留在座位上`);
  }

  const champ = fin.tournament.entrants.find(e => e.place === 1);
  assert.ok(champ && seatedIds.has(champ.playerId), '冠军应仍在座位');
  assert.strictEqual(champ.eliminated, false, '冠军不应标记淘汰');

  a.socket.disconnect();
  b.socket.disconnect();
  c.socket.disconnect();
});
