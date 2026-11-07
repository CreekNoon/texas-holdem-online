const test = require('node:test');
const assert = require('node:assert');
const { evaluate7 } = require('../game/evaluator7');
const { evaluateBest, evaluateBestBruteForce, compareHands } = require('../game/handEvaluator');
const { Deck } = require('../game/deck');

const c = (suit, rank) => ({ suit, rank });

function random7() {
  return new Deck().cards.slice(0, 7);
}

test('3.2 evaluate7 只接受 7 张', () => {
  assert.strictEqual(evaluate7([]), null);
  assert.strictEqual(evaluate7(null), null);
  assert.strictEqual(evaluate7(undefined), null);
  assert.strictEqual(evaluate7([c('spades', 'A')]), null);
  assert.strictEqual(evaluate7(random7().slice(0, 5)), null);
  assert.strictEqual(evaluate7(random7().slice(0, 6)), null);
});

test('3.2 evaluate7 与暴力实现 1 万手完全一致', () => {
  for (let i = 0; i < 10000; i++) {
    const cards = random7();
    const fast = evaluate7(cards);
    const brute = evaluateBestBruteForce(cards);
    assert.strictEqual(fast.rank, brute.rank,
      `rank 不一致: ${cards.map(x => x.suit[0] + x.rank).join(' ')}`);
    assert.deepStrictEqual(fast.tiebreakers, brute.tiebreakers,
      `tiebreakers 不一致: ${cards.map(x => x.suit[0] + x.rank).join(' ')}`);
  }
});

test('3.2 evaluateBest 7 张走快速路径且结果一致', () => {
  for (let i = 0; i < 2000; i++) {
    const cards = random7();
    const fast = evaluateBest(cards);
    const brute = evaluateBestBruteForce(cards);
    assert.strictEqual(compareHands(fast, brute), 0);
  }
});

test('3.2 evaluate7 各牌型识别正确', () => {
  // 皇家同花顺
  assert.strictEqual(evaluate7([
    c('spades', '10'), c('spades', 'J'), c('spades', 'Q'),
    c('spades', 'K'), c('spades', 'A'), c('hearts', '2'), c('clubs', '3')
  ]).name, '皇家同花顺');

  // 同花顺
  assert.strictEqual(evaluate7([
    c('hearts', '5'), c('hearts', '6'), c('hearts', '7'),
    c('hearts', '8'), c('hearts', '9'), c('spades', '2'), c('clubs', '3')
  ]).name, '同花顺');

  // 四条
  assert.strictEqual(evaluate7([
    c('spades', '7'), c('hearts', '7'), c('diamonds', '7'),
    c('clubs', '7'), c('spades', 'K'), c('hearts', '2'), c('clubs', '3')
  ]).name, '四条');

  // 葫芦
  assert.strictEqual(evaluate7([
    c('spades', '9'), c('hearts', '9'), c('diamonds', '9'),
    c('clubs', '4'), c('spades', '4'), c('hearts', '2'), c('clubs', '3')
  ]).name, '葫芦');

  // 同花
  assert.strictEqual(evaluate7([
    c('clubs', '2'), c('clubs', '5'), c('clubs', '9'),
    c('clubs', 'J'), c('clubs', 'K'), c('spades', '3'), c('hearts', '4')
  ]).name, '同花');

  // 顺子
  assert.strictEqual(evaluate7([
    c('spades', '6'), c('hearts', '7'), c('diamonds', '8'),
    c('clubs', '9'), c('spades', '10'), c('hearts', '2'), c('clubs', '3')
  ]).name, '顺子');

  // wheel
  const wheel = evaluate7([
    c('spades', 'A'), c('hearts', '2'), c('diamonds', '3'),
    c('clubs', '4'), c('spades', '5'), c('hearts', 'K'), c('clubs', 'Q')
  ]);
  assert.strictEqual(wheel.name, '顺子');
  assert.deepStrictEqual(wheel.tiebreakers, [5]);

  // 两对
  assert.strictEqual(evaluate7([
    c('spades', 'A'), c('hearts', 'A'), c('diamonds', 'K'),
    c('clubs', 'K'), c('spades', '7'), c('hearts', '2'), c('clubs', '3')
  ]).name, '两对');

  // 一对
  assert.strictEqual(evaluate7([
    c('spades', 'Q'), c('hearts', 'Q'), c('diamonds', '9'),
    c('clubs', '5'), c('spades', '2'), c('hearts', '7'), c('clubs', '3')
  ]).name, '一对');

  // 高牌
  assert.strictEqual(evaluate7([
    c('spades', 'A'), c('hearts', 'J'), c('diamonds', '9'),
    c('clubs', '5'), c('spades', '2'), c('hearts', '7'), c('clubs', '4')
  ]).name, '高牌');
});

test('3.2 evaluate7 多个三条时取最大葫芦', () => {
  const hand = evaluate7([
    c('spades', '9'), c('hearts', '9'), c('diamonds', '9'),
    c('clubs', '5'), c('spades', '5'), c('hearts', '5'), c('clubs', '2')
  ]);
  assert.strictEqual(hand.name, '葫芦');
  assert.deepStrictEqual(hand.tiebreakers, [9, 5]);
});

test('3.2 evaluate7 三个对子取最大两对', () => {
  const hand = evaluate7([
    c('spades', 'A'), c('hearts', 'A'),
    c('diamonds', 'K'), c('clubs', 'K'),
    c('spades', '9'), c('hearts', '9'), c('clubs', '2')
  ]);
  assert.strictEqual(hand.name, '两对');
  assert.deepStrictEqual(hand.tiebreakers, [14, 13, 9]);
});

test('3.2 evaluate7 性能：3000 次评估 < 50ms', () => {
  const hands = Array.from({ length: 3000 }, random7);
  const t0 = process.hrtime.bigint();
  for (const h of hands) evaluate7(h);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, `3000 次评估耗时 ${ms.toFixed(1)}ms，应 < 50ms`);
});
