const test = require('node:test');
const assert = require('node:assert');
const { equity, clearEquityCache } = require('../game/equity');

const c = (suit, rank) => ({ suit, rank });

test('3.1 AA vs KK 翻前胜率在 79%–83%', () => {
  clearEquityCache();
  const result = equity({
    hole: [c('spades', 'A'), c('hearts', 'A')],
    opponentHands: [[c('diamonds', 'K'), c('clubs', 'K')]],
    iterations: 10000,
    useCache: false
  });
  assert.ok(result.equity >= 0.79 && result.equity <= 0.83,
    `AA vs KK 胜率 ${(result.equity * 100).toFixed(2)}%，应在 79%–83%`);
});

test('3.1 AA 对随机 1 对手约 85%', () => {
  clearEquityCache();
  const result = equity({
    hole: [c('spades', 'A'), c('hearts', 'A')],
    opponents: 1,
    iterations: 10000,
    useCache: false
  });
  assert.ok(result.equity >= 0.82 && result.equity <= 0.88,
    `AA vs random 胜率 ${(result.equity * 100).toFixed(2)}%，应约 85%`);
});

test('3.1 胜率三态之和为 1', () => {
  const result = equity({
    hole: [c('spades', 'A'), c('hearts', 'K')],
    board: [c('hearts', 'Q'), c('clubs', 'J'), c('diamonds', '2')],
    opponents: 2,
    iterations: 2000,
    useCache: false
  });
  const sum = result.win + result.tie + result.lose;
  assert.ok(Math.abs(sum - 1) < 1e-9, `win+tie+lose 应等于 1，实际 ${sum}`);
});

test('3.1 参数校验：hole 必须是 2 张', () => {
  assert.throws(() => equity({ hole: [], opponents: 1 }), /hole/);
  assert.throws(() => equity({ hole: [c('spades', 'A')], opponents: 1 }), /hole/);
});

test('3.1 参数校验：board 最多 5 张', () => {
  assert.throws(() => equity({
    hole: [c('spades', 'A'), c('hearts', 'A')],
    board: Array(6).fill(c('clubs', '2')),
    opponents: 1
  }), /board/);
});

test('3.1 参数校验：opponents 范围 1–6', () => {
  const hole = [c('spades', 'A'), c('hearts', 'A')];
  assert.throws(() => equity({ hole, opponents: 0 }), /opponents/);
  assert.throws(() => equity({ hole, opponents: 7 }), /opponents/);
  assert.throws(() => equity({ hole, opponents: 1.5 }), /opponents/);
});

test('3.1 重复牌被拒绝', () => {
  assert.throws(() => equity({
    hole: [c('spades', 'A'), c('spades', 'A')],
    opponents: 1
  }), /重复牌/);

  assert.throws(() => equity({
    hole: [c('spades', 'A'), c('hearts', 'A')],
    board: [c('spades', 'A')],
    opponents: 1
  }), /重复牌/);
});

test('3.1 已知对手底牌与随机对手互斥', () => {
  const hole = [c('spades', 'A'), c('hearts', 'A')];
  const r = equity({
    hole,
    opponentHands: [[c('diamonds', 'K'), c('clubs', 'K')]],
    opponents: 3, // 应被忽略
    iterations: 100,
    useCache: false
  });
  assert.ok(r.equity > 0);
});

test('3.1 缓存命中返回 cached=true', () => {
  clearEquityCache();
  const opts = {
    hole: [c('spades', 'A'), c('hearts', 'K')],
    board: [c('hearts', 'Q'), c('clubs', 'J'), c('diamonds', '2')],
    opponents: 1,
    iterations: 500
  };
  const first = equity(opts);
  assert.strictEqual(first.cached, false);
  const second = equity(opts);
  assert.strictEqual(second.cached, true);
  assert.strictEqual(second.equity, first.equity);
});

test('3.1 缓存键区分不同 iterations', () => {
  clearEquityCache();
  const base = {
    hole: [c('spades', 'A'), c('hearts', 'K')],
    board: [c('hearts', 'Q'), c('clubs', 'J'), c('diamonds', '2')],
    opponents: 1
  };
  const a = equity({ ...base, iterations: 100 });
  const b = equity({ ...base, iterations: 200 });
  assert.strictEqual(a.cached, false);
  assert.strictEqual(b.cached, false);
});

test('3.2 性能：3000 iter / 3 opponents < 150ms', () => {
  const t0 = process.hrtime.bigint();
  equity({
    hole: [c('spades', 'A'), c('hearts', 'K')],
    board: [c('hearts', 'Q'), c('clubs', 'J'), c('diamonds', '2')],
    opponents: 3,
    iterations: 3000,
    useCache: false
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 150, `耗时 ${ms.toFixed(1)}ms，应 < 150ms`);
});

test('3.1 听牌场景：翻牌同花听牌胜率合理', () => {
  // 手持 A♥ K♥，翻牌 Q♥ J♥ 2♣ → 同花 + 顺子双听，胜率应显著高于 30%
  const result = equity({
    hole: [c('hearts', 'A'), c('hearts', 'K')],
    board: [c('hearts', 'Q'), c('hearts', 'J'), c('clubs', '2')],
    opponents: 1,
    iterations: 5000,
    useCache: false
  });
  assert.ok(result.equity > 0.5, `强听牌胜率 ${(result.equity * 100).toFixed(1)}% 应 > 50%`);
});
