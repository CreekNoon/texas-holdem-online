const test = require('node:test');
const assert = require('node:assert');
const { evaluate5, evaluateBest, compareHands } = require('../game/handEvaluator');

const c = (suit, rank) => ({ suit, rank });

test('牌型：皇家同花顺', () => {
  const hand = evaluate5([
    c('spades', '10'), c('spades', 'J'), c('spades', 'Q'),
    c('spades', 'K'), c('spades', 'A')
  ]);
  assert.strictEqual(hand.name, '皇家同花顺');
  assert.strictEqual(hand.rank, 9);
});

test('牌型：同花顺', () => {
  const hand = evaluate5([
    c('hearts', '5'), c('hearts', '6'), c('hearts', '7'),
    c('hearts', '8'), c('hearts', '9')
  ]);
  assert.strictEqual(hand.name, '同花顺');
  assert.deepStrictEqual(hand.tiebreakers, [9]);
});

test('牌型：四条', () => {
  const hand = evaluate5([
    c('spades', '7'), c('hearts', '7'), c('diamonds', '7'),
    c('clubs', '7'), c('spades', 'K')
  ]);
  assert.strictEqual(hand.name, '四条');
  assert.deepStrictEqual(hand.tiebreakers, [7, 13]);
});

test('牌型：葫芦', () => {
  const hand = evaluate5([
    c('spades', '9'), c('hearts', '9'), c('diamonds', '9'),
    c('clubs', '4'), c('spades', '4')
  ]);
  assert.strictEqual(hand.name, '葫芦');
  assert.deepStrictEqual(hand.tiebreakers, [9, 4]);
});

test('牌型：同花', () => {
  const hand = evaluate5([
    c('clubs', '2'), c('clubs', '5'), c('clubs', '9'),
    c('clubs', 'J'), c('clubs', 'K')
  ]);
  assert.strictEqual(hand.name, '同花');
  assert.deepStrictEqual(hand.tiebreakers, [13, 11, 9, 5, 2]);
});

test('牌型：顺子', () => {
  const hand = evaluate5([
    c('spades', '6'), c('hearts', '7'), c('diamonds', '8'),
    c('clubs', '9'), c('spades', '10')
  ]);
  assert.strictEqual(hand.name, '顺子');
  assert.deepStrictEqual(hand.tiebreakers, [10]);
});

test('牌型：wheel（A-2-3-4-5）按 5 高顺子算', () => {
  const hand = evaluate5([
    c('spades', 'A'), c('hearts', '2'), c('diamonds', '3'),
    c('clubs', '4'), c('spades', '5')
  ]);
  assert.strictEqual(hand.name, '顺子');
  assert.deepStrictEqual(hand.tiebreakers, [5], 'wheel 不能算 14 高');
});

test('牌型：三条', () => {
  const hand = evaluate5([
    c('spades', '8'), c('hearts', '8'), c('diamonds', '8'),
    c('clubs', 'K'), c('spades', '3')
  ]);
  assert.strictEqual(hand.name, '三条');
  assert.deepStrictEqual(hand.tiebreakers, [8, 13, 3]);
});

test('牌型：两对', () => {
  const hand = evaluate5([
    c('spades', 'A'), c('hearts', 'A'), c('diamonds', 'K'),
    c('clubs', 'K'), c('spades', '7')
  ]);
  assert.strictEqual(hand.name, '两对');
  assert.deepStrictEqual(hand.tiebreakers, [14, 13, 7]);
});

test('牌型：一对', () => {
  const hand = evaluate5([
    c('spades', 'Q'), c('hearts', 'Q'), c('diamonds', '9'),
    c('clubs', '5'), c('spades', '2')
  ]);
  assert.strictEqual(hand.name, '一对');
  assert.deepStrictEqual(hand.tiebreakers, [12, 9, 5, 2]);
});

test('牌型：高牌', () => {
  const hand = evaluate5([
    c('spades', 'A'), c('hearts', 'J'), c('diamonds', '9'),
    c('clubs', '5'), c('spades', '2')
  ]);
  assert.strictEqual(hand.name, '高牌');
  assert.deepStrictEqual(hand.tiebreakers, [14, 11, 9, 5, 2]);
});

test('踢脚牌比较：同为一对时比踢脚', () => {
  const a = evaluate5([
    c('spades', 'A'), c('hearts', 'A'), c('diamonds', 'K'),
    c('clubs', '9'), c('spades', '5')
  ]);
  const b = evaluate5([
    c('spades', 'A'), c('clubs', 'A'), c('diamonds', 'Q'),
    c('hearts', '9'), c('hearts', '5')
  ]);
  assert.ok(compareHands(a, b) > 0, 'K 踢脚应胜过 Q 踢脚');
});

test('3.10 不足 5 张返回 null，不误判为同花', () => {
  assert.strictEqual(evaluate5([c('hearts', '2'), c('hearts', '7')]), null);
  assert.strictEqual(evaluate5([c('hearts', '2'), c('hearts', '7'), c('hearts', '9')]), null);
  assert.strictEqual(evaluate5([]), null);
  assert.strictEqual(evaluate5(null), null);
  assert.strictEqual(evaluate5(undefined), null);
});

test('3.10 evaluateBest 空牌/不足 5 张返回 null', () => {
  assert.strictEqual(evaluateBest([]), null);
  assert.strictEqual(evaluateBest([c('hearts', '2'), c('hearts', '7')]), null);
  assert.strictEqual(evaluateBest(null), null);
});

test('3.10 compareHands 对 null 安全', () => {
  assert.strictEqual(compareHands(null, null), 0);
  assert.ok(compareHands(evaluate5([c('spades', 'A'), c('hearts', 'A'), c('diamonds', 'K'), c('clubs', '9'), c('spades', '5')]), null) > 0);
  assert.ok(compareHands(null, evaluate5([c('spades', 'A'), c('hearts', 'A'), c('diamonds', 'K'), c('clubs', '9'), c('spades', '5')])) < 0);
});

test('7 选 5：从 7 张中选出最佳组合', () => {
  const best = evaluateBest([
    c('spades', 'A'), c('hearts', 'A'),
    c('diamonds', 'K'), c('clubs', 'K'),
    c('spades', 'K'), c('hearts', '3'), c('clubs', '2')
  ]);
  assert.strictEqual(best.name, '葫芦');
  assert.deepStrictEqual(best.tiebreakers, [13, 14]);
});

test('7 张同花取最高 5 张', () => {
  const best = evaluateBest([
    c('hearts', '2'), c('hearts', '5'), c('hearts', '7'),
    c('hearts', '9'), c('hearts', 'J'), c('hearts', 'K'),
    c('spades', 'A')
  ]);
  assert.strictEqual(best.name, '同花');
  assert.deepStrictEqual(best.tiebreakers, [13, 11, 9, 7, 5]);
});
