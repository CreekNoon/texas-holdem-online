const test = require('node:test');
const assert = require('node:assert');
const {
  Tournament, STATE, DEFAULT_BLIND_SCHEDULE,
  defaultPayoutStructure, computePayouts
} = require('../game/tournament');

function newTournament(opts = {}) {
  return new Tournament({ buyIn: 100, startingChips: 1000, ...opts });
}

// ===== 奖金（§3.2）=====

test('3.2 奖金结构：3 人以上 50/30/20', () => {
  assert.deepStrictEqual(defaultPayoutStructure(3), [
    { place: 1, percent: 50 }, { place: 2, percent: 30 }, { place: 3, percent: 20 }
  ]);
  assert.deepStrictEqual(defaultPayoutStructure(7), defaultPayoutStructure(3));
});

test('3.2 奖金结构：2 人 65/35', () => {
  assert.deepStrictEqual(defaultPayoutStructure(2), [
    { place: 1, percent: 65 }, { place: 2, percent: 35 }
  ]);
});

test('3.2 奖金向下取整，余数给冠军', () => {
  // 6 人 × 100 = 600；50%=300, 30%=180, 20%=120 → 刚好
  assert.deepStrictEqual(computePayouts(600, defaultPayoutStructure(6)),
    { 1: 300, 2: 180, 3: 120 });

  // 333：50%=166.5→166, 30%=99.9→99, 20%=66.6→66，共 331，余 2 给冠军
  const p = computePayouts(333, defaultPayoutStructure(3));
  assert.strictEqual(p[1] + p[2] + p[3], 333, '奖金总额必须等于奖池');
  assert.strictEqual(p[1], 168);
});

test('3.2 奖金总额始终等于奖池', () => {
  for (let pool = 1; pool <= 1000; pool += 7) {
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const payouts = computePayouts(pool, defaultPayoutStructure(n));
      const sum = Object.values(payouts).reduce((a, b) => a + b, 0);
      assert.strictEqual(sum, pool, `奖池 ${pool} / ${n} 人时总额不符`);
    }
  }
});

// ===== 报名（§4.1）=====

test('4.1 报名：至少 2 人才能开始', () => {
  const t = newTournament();
  t.register('p1', 'A');
  assert.strictEqual(t.start(), false, '1 人不能开始');
  t.register('p2', 'B');
  assert.strictEqual(t.start(), true);
});

test('4.1 报名：满员后拒绝', () => {
  const t = newTournament({ maxPlayers: 3 });
  for (let i = 0; i < 3; i++) t.register('p' + i, 'P' + i);
  assert.strictEqual(t.register('p9', 'X'), null, '满员应拒绝');
});

test('4.1 报名：同一玩家不能重复报名', () => {
  const t = newTournament();
  assert.ok(t.register('p1', 'A'));
  assert.strictEqual(t.register('p1', 'A'), null);
});

test('4.1 报名阶段可退出', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  assert.strictEqual(t.unregister('p1'), true);
  assert.strictEqual(t.entrantCount, 1);
});

test('4.1 开赛后不能报名/退出', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start();
  assert.strictEqual(t.register('p3', 'C'), null);
  assert.strictEqual(t.unregister('p1'), false);
});

test('4.1 奖池 = 买入 × 人数', () => {
  const t = newTournament({ buyIn: 250 });
  for (let i = 0; i < 5; i++) t.register('p' + i, 'P' + i);
  t.start();
  assert.strictEqual(t.prizePool, 250 * 5);
});

test('4.1 起始筹码与初始盲注', () => {
  const t = newTournament({ startingChips: 2000 });
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(1000);
  assert.strictEqual(t.startingChips, 2000);
  assert.deepStrictEqual(t.blinds, { sb: 10, bb: 20, ante: 0 });
  assert.strictEqual(t.levelEndsAt, 1000 + DEFAULT_BLIND_SCHEDULE[0].durationMs);
});

// ===== 盲注升级（§4.2）=====

test('4.2 时间未到不升级', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);
  assert.strictEqual(t.tickLevel(100, false), null, '时间未到');
  assert.strictEqual(t.levelIndex, 0);
});

test('4.2 时间到且无进行中的手 → 立即升级', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);
  const end = t.levelEndsAt;
  const change = t.tickLevel(end, false);
  assert.ok(change && !change.pending);
  assert.strictEqual(change.level, 2);
  assert.strictEqual(t.levelIndex, 1);
  assert.deepStrictEqual(t.blinds, { sb: 15, bb: 30, ante: 0 });
});

test('4.2 时间到但有进行中的手 → 挂起，本手结束后生效', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);
  const end = t.levelEndsAt;

  const change = t.tickLevel(end, true);
  assert.ok(change.pending);
  assert.strictEqual(t.pendingLevel, true);
  assert.strictEqual(t.levelIndex, 0, '挂起时不应立即升级');

  const applied = t.applyPendingLevel(end);
  assert.ok(applied);
  assert.strictEqual(t.levelIndex, 1);
  assert.strictEqual(t.pendingLevel, false);
});

test('4.2 最后一档不再升级', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);
  t.levelIndex = t.blindSchedule.length - 1;
  t.levelEndsAt = 0;
  assert.strictEqual(t.tickLevel(100, false), null);
});

test('4.2 升级后 levelEndsAt 按新等级时长重置', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);
  const end = t.levelEndsAt;
  t.tickLevel(end, false);
  assert.strictEqual(t.levelEndsAt, end + t.currentLevel.durationMs);
});

test('4.2 前 3 级无前注，第 3 级起有前注', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);

  assert.strictEqual(t.blindSchedule[0].ante, 0);
  assert.strictEqual(t.blindSchedule[1].ante, 0);
  assert.strictEqual(t.blindSchedule[2].ante, 5);
  assert.ok(t.blindSchedule[3].ante > 0);
});

// ===== 淘汰与名次（§4.4）=====

test('4.4 筹码归零即淘汰并记录名次', () => {
  const t = newTournament();
  ['a', 'b', 'c'].forEach((id, i) => t.register('p_' + id, 'P' + i));
  t.start();

  // 3 人：A 出局 → 第 3 名
  t.entrants[0].chips = 0;
  t.entrants[0].chipsAtHandStart = 100;
  t.entrants[1].chips = 500;
  t.entrants[2].chips = 500;

  const result = t.eliminateBusted();
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0].place, 3);
  assert.strictEqual(t.entrants[0].eliminated, true);
});

test('4.4 同时淘汰按本手开始前筹码降序', () => {
  const t = newTournament();
  ['a', 'b', 'c', 'd', 'e', 'f'].forEach((id, i) => t.register('p_' + id, 'P' + i));
  t.start();

  // 6 人，3 人同时出局；本手开始前筹码：A=500, B=1000, C=200
  t.entrants.forEach((e, i) => { e.chips = 500; });
  t.entrants[0].chips = 0; t.entrants[0].chipsAtHandStart = 500;
  t.entrants[1].chips = 0; t.entrants[1].chipsAtHandStart = 1000;
  t.entrants[2].chips = 0; t.entrants[2].chipsAtHandStart = 200;

  const result = t.eliminateBusted();
  assert.strictEqual(result.length, 3);

  // 筹码多者名次靠前（名次号小）：B(1000) → 4, A(500) → 5, C(200) → 6
  const byId = Object.fromEntries(result.map(r => [r.playerId, r.place]));
  assert.strictEqual(byId['p_b'], 4);
  assert.strictEqual(byId['p_a'], 5);
  assert.strictEqual(byId['p_c'], 6);
});

test('4.4 同时淘汰且筹码相同 → 按座位顺序', () => {
  const t = newTournament();
  ['a', 'b', 'c', 'd'].forEach((id, i) => t.register('p_' + id, 'P' + i));
  t.start();

  t.entrants.forEach(e => { e.chips = 500; });
  // 前两人同时出局，开始前筹码相同
  t.entrants[0].chips = 0; t.entrants[0].chipsAtHandStart = 300;
  t.entrants[1].chips = 0; t.entrants[1].chipsAtHandStart = 300;

  const result = t.eliminateBusted();
  const byId = Object.fromEntries(result.map(r => [r.playerId, r.place]));
  // 座位靠前者名次靠前
  assert.ok(byId['p_a'] < byId['p_b'], '座位靠前者应获得更好名次');
});

test('4.4 名次唯一且连续', () => {
  const t = newTournament();
  for (let i = 0; i < 6; i++) t.register('p' + i, 'P' + i);
  t.start();

  // 逐个淘汰
  for (let i = 0; i < 5; i++) {
    t.entrants.forEach(e => { if (!e.eliminated) { e.chips = 100; e.chipsAtHandStart = 100; } });
    t.entrants[i].chips = 0;
    t.eliminateBusted();
  }
  t.finish();

  const places = t.entrants.map(e => e.place).sort((a, b) => a - b);
  assert.deepStrictEqual(places, [1, 2, 3, 4, 5, 6], '名次应为 1..6 且唯一');
});

test('4.4 只剩一人 → 结束并产生冠军', () => {
  const t = newTournament();
  ['a', 'b', 'c'].forEach((id, i) => t.register('p_' + id, 'P' + i));
  t.start();

  t.entrants[0].chips = 0; t.entrants[0].chipsAtHandStart = 100;
  t.entrants[1].chips = 0; t.entrants[1].chipsAtHandStart = 100;
  t.entrants[2].chips = 2000; t.entrants[2].chipsAtHandStart = 2000;

  t.onHandFinished();

  assert.strictEqual(t.state, STATE.FINISHED);
  assert.strictEqual(t.entrants[2].place, 1, '存活者应是冠军');
  assert.ok(t.entrants[2].payout > 0, '冠军应有奖金');
});

test('4.4 结束后奖金总额等于奖池', () => {
  const t = newTournament({ buyIn: 100 });
  for (let i = 0; i < 6; i++) t.register('p' + i, 'P' + i);
  t.start();

  // 淘汰到只剩 1 人
  for (let i = 0; i < 5; i++) {
    t.entrants.forEach(e => { if (!e.eliminated) { e.chips = 100; e.chipsAtHandStart = 100; } });
    t.entrants[i].chips = 0;
    t.eliminateBusted();
  }
  t.finish();

  const total = t.entrants.reduce((a, e) => a + e.payout, 0);
  assert.strictEqual(total, t.prizePool, '奖金总额必须等于奖池');
});

// ===== 状态快照（§5.1）=====

test('5.1 toPublicState 包含完整字段', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start();

  const s = t.toPublicState();
  for (const key of ['state', 'buyIn', 'prizePool', 'level', 'sb', 'bb', 'ante',
                     'levelEndsAt', 'nextLevel', 'entrants', 'payoutStructure']) {
    assert.ok(key in s, `缺少字段 ${key}`);
  }
  assert.strictEqual(s.state, 'running');
  assert.strictEqual(s.level, 1);
  assert.strictEqual(s.sb, 10);
  assert.strictEqual(s.bb, 20);
  assert.strictEqual(s.aliveCount, 2);
});

test('5.1 快照不泄露任何底牌', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start();
  const json = JSON.stringify(t.toPublicState());
  assert.ok(!json.includes('"hand"'), '锦标赛快照不应包含 hand 字段');
  assert.ok(!json.includes('"holeCards"'), '锦标赛快照不应包含 holeCards');
});

test('5.1 nextLevel 在最后一档为 null', () => {
  const t = newTournament();
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start();
  t.levelIndex = t.blindSchedule.length - 1;
  assert.strictEqual(t.nextLevel, null);
});

test('4.4 最后两人同时出局时仍产生冠军（冠军 eliminated=false）', () => {
  const t = newTournament({ buyIn: 100 });
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start();

  // 双方筹码同时归零（all-in 对撞的极端情况）
  t.entrants.forEach(e => { e.chips = 100; e.chipsAtHandStart = 100; });
  t.entrants[0].chips = 0;
  t.entrants[1].chips = 0;

  t.onHandFinished();

  assert.strictEqual(t.state, STATE.FINISHED);
  const places = t.entrants.map(e => e.place).sort((a, b) => a - b);
  assert.deepStrictEqual(places, [1, 2], '必须产生 1、2 名');

  const champ = t.entrants.find(e => e.place === 1);
  assert.strictEqual(champ.eliminated, false, '冠军不能标记为已淘汰');

  const total = t.entrants.reduce((a, e) => a + e.payout, 0);
  assert.strictEqual(total, t.prizePool, '奖金总额必须等于奖池');
});

test('4.4 冠军始终 eliminated=false（多人局）', () => {
  const t = newTournament({ buyIn: 100 });
  for (let i = 0; i < 5; i++) t.register('p' + i, 'P' + i);
  t.start();

  t.entrants.forEach(e => { e.chips = 100; e.chipsAtHandStart = 100; });
  // 4 人同时出局，1 人存活
  for (let i = 0; i < 4; i++) t.entrants[i].chips = 0;
  t.entrants[4].chips = 500;

  t.onHandFinished();

  const champ = t.entrants.find(e => e.place === 1);
  assert.ok(champ, '应有冠军');
  assert.strictEqual(champ.eliminated, false);
  assert.ok(!t.eliminationOrder.slice(0, -1).includes(champ.playerId),
    '冠军不应出现在淘汰顺序的前段');
});

test('4.4 冠军总是淘汰顺序的最后一位', () => {
  const t = newTournament({ buyIn: 100 });
  ['a', 'b', 'c'].forEach((id, i) => t.register('p_' + id, 'P' + i));
  t.start();

  t.entrants.forEach(e => { e.chips = 100; e.chipsAtHandStart = 100; });
  t.entrants[0].chips = 0;
  t.entrants[1].chips = 0;
  t.entrants[2].chips = 300;
  t.onHandFinished();

  const champ = t.entrants.find(e => e.place === 1);
  assert.strictEqual(t.eliminationOrder[t.eliminationOrder.length - 1], champ.playerId,
    '冠军应最后进入淘汰顺序（存活到最后）');
});

test('4.2 levelDurationMs 可注入（测试加速）', () => {
  const t = newTournament({ levelDurationMs: 50 });
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);

  assert.strictEqual(t.levelEndsAt, 50, '应使用注入的等级时长');
  assert.ok(t.blindSchedule.every(lv => lv.durationMs === 50),
    '所有等级时长都应被覆盖');
});

test('4.2 连续升级到最后一档', () => {
  const t = newTournament({ levelDurationMs: 10 });
  t.register('p1', 'A');
  t.register('p2', 'B');
  t.start(0);

  let now = 10;
  let guard = 0;
  while (t.levelIndex < t.blindSchedule.length - 1 && guard++ < 50) {
    const change = t.tickLevel(now, false);
    if (change && !change.pending) now = t.levelEndsAt;
    else break;
  }

  assert.strictEqual(t.levelIndex, t.blindSchedule.length - 1, '应升到最后一档');
  // 最后一档不再升级
  assert.strictEqual(t.tickLevel(now + 10000, false), null);
});
