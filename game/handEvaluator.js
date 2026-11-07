const { rankValue } = require('./deck');
const { HAND_RANK } = require('./handRank');
const { evaluate7 } = require('./evaluator7');

// 评估一副 5 张牌，返回 { rank, name, tiebreakers: [..] }
// 不足 5 张返回 null（不足 5 张无法构成完整牌型，见 PRD-01 §3.10）
function evaluate5(cards) {
  if (!Array.isArray(cards) || cards.length !== 5) return null;

  const values = cards.map(c => rankValue(c.rank)).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);

  const isFlush = suits.every(s => s === suits[0]);

  // 判断顺子
  let isStraight = false;
  let straightHigh = 0;
  const uniqueVals = [...new Set(values)].sort((a, b) => b - a);

  // 普通顺子
  if (uniqueVals.length === 5) {
    if (uniqueVals[0] - uniqueVals[4] === 4) {
      isStraight = true;
      straightHigh = uniqueVals[0];
    }
    // A-2-3-4-5 特殊顺子 (wheel)
    if (uniqueVals[0] === 14 && uniqueVals[1] === 5 && uniqueVals[4] === 2) {
      isStraight = true;
      straightHigh = 5;
    }
  }

  // 统计每张点数出现次数
  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  // 按 [次数, 点数] 降序排列
  const groups = Object.entries(counts)
    .map(([v, c]) => ({ value: parseInt(v), count: c }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  // 皇家同花顺
  if (isFlush && isStraight && straightHigh === 14) {
    return { rank: HAND_RANK.ROYAL_FLUSH, name: '皇家同花顺', tiebreakers: [] };
  }
  // 同花顺
  if (isFlush && isStraight) {
    return { rank: HAND_RANK.STRAIGHT_FLUSH, name: '同花顺', tiebreakers: [straightHigh] };
  }
  // 四条
  if (groups[0].count === 4) {
    const kicker = values.find(v => v !== groups[0].value);
    return { rank: HAND_RANK.FOUR_OF_A_KIND, name: '四条', tiebreakers: [groups[0].value, kicker] };
  }
  // 葫芦 (三条 + 一对)
  if (groups[0].count === 3 && groups[1].count === 2) {
    return { rank: HAND_RANK.FULL_HOUSE, name: '葫芦', tiebreakers: [groups[0].value, groups[1].value] };
  }
  // 同花
  if (isFlush) {
    return { rank: HAND_RANK.FLUSH, name: '同花', tiebreakers: values };
  }
  // 顺子
  if (isStraight) {
    return { rank: HAND_RANK.STRAIGHT, name: '顺子', tiebreakers: [straightHigh] };
  }
  // 三条
  if (groups[0].count === 3) {
    const kickers = values.filter(v => v !== groups[0].value);
    return { rank: HAND_RANK.THREE_OF_A_KIND, name: '三条', tiebreakers: [groups[0].value, ...kickers] };
  }
  // 两对
  if (groups[0].count === 2 && groups[1].count === 2) {
    const highPair = Math.max(groups[0].value, groups[1].value);
    const lowPair = Math.min(groups[0].value, groups[1].value);
    const kicker = values.find(v => v !== groups[0].value && v !== groups[1].value);
    return { rank: HAND_RANK.TWO_PAIR, name: '两对', tiebreakers: [highPair, lowPair, kicker] };
  }
  // 一对
  if (groups[0].count === 2) {
    const kickers = values.filter(v => v !== groups[0].value);
    return { rank: HAND_RANK.ONE_PAIR, name: '一对', tiebreakers: [groups[0].value, ...kickers] };
  }
  // 高牌
  return { rank: HAND_RANK.HIGH_CARD, name: '高牌', tiebreakers: values };
}

// 生成 n 选 k 的所有组合
function combinations(arr, k) {
  const result = [];
  function helper(start, combo) {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      helper(i + 1, combo);
      combo.pop();
    }
  }
  helper(0, []);
  return result;
}

// 从 5–7 张牌中评估最佳 5 张牌
// 不足 5 张返回 null，不抛错
// 7 张默认走快速路径 evaluate7（PRD-03 §3.2）；
// 传 { withCards: true } 时额外返回 bestCards（PRD-04 §3.5），此时走组合枚举。
function evaluateBest(cards, options = {}) {
  if (!Array.isArray(cards) || cards.length < 5) return null;
  const { withCards = false } = options;

  if (cards.length === 5) {
    const hand = evaluate5(cards);
    return withCards && hand ? { ...hand, bestCards: cards.slice() } : hand;
  }

  if (cards.length === 7 && !withCards) {
    return evaluate7(cards);
  }

  const combos = combinations(cards, 5);
  let best = null;
  let bestCombo = null;
  for (const combo of combos) {
    const hand = evaluate5(combo);
    if (!best || compareHands(hand, best) > 0) {
      best = hand;
      bestCombo = combo;
    }
  }
  return withCards && best ? { ...best, bestCards: bestCombo } : best;
}

// 暴力实现：仅用于测试对照（PRD-03 §3.2）
function evaluateBestBruteForce(cards) {
  if (!Array.isArray(cards) || cards.length < 5) return null;
  if (cards.length === 5) return evaluate5(cards);

  const combos = combinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const hand = evaluate5(combo);
    if (!best || compareHands(hand, best) > 0) {
      best = hand;
    }
  }
  return best;
}

// 比较两手牌, >0 表示 a 胜, <0 表示 b 胜, 0 表示平局
// null 入参按“无牌”处理，双方都无牌时为平局
function compareHands(a, b) {
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  if (a.rank !== b.rank) return a.rank - b.rank;
  for (let i = 0; i < Math.max(a.tiebreakers.length, b.tiebreakers.length); i++) {
    const av = a.tiebreakers[i] || 0;
    const bv = b.tiebreakers[i] || 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

module.exports = { evaluate5, evaluateBest, evaluateBestBruteForce, compareHands, HAND_RANK };
