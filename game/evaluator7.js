// 7 张牌快速评估（PRD-03 §3.2）
//
// 目标：返回结构与 evaluate5 完全一致 { rank, name, tiebreakers }，
// 但用位图 + 计数一次扫描完成，避免 21 种 5 张组合枚举。
//
// 只接受恰好 7 张牌；其余长度返回 null（与 PRD-01 §3.10 一致）。

const { HAND_RANK } = require('./handRank');

const RANK_VALUE = {
  '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
  '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14
};

// 5 张顺子判定：从 13 位点数掩码里找最高顺子（含 wheel）
function straightHighFromMask(mask) {
  // A=14 对应 bit 12（0-based：2→0 ... A→12）
  const bit = (v) => 1 << (v - 2);

  // 普通顺子：high 从 14 到 6（5 高的 A-2-3-4-5 单独处理，否则会算出 bit(1)）
  for (let high = 14; high >= 6; high--) {
    let need = 0;
    for (let i = 0; i < 5; i++) need |= bit(high - i);
    if ((mask & need) === need) return high;
  }

  // wheel: A,2,3,4,5 → 5 高
  const wheelMask = bit(14) | bit(2) | bit(3) | bit(4) | bit(5);
  if ((mask & wheelMask) === wheelMask) return 5;

  return 0;
}

// 从一组点数里取前 n 大的值
function topN(values, n) {
  return values.slice(0, n);
}

function evaluate7(cards) {
  if (!Array.isArray(cards) || cards.length !== 7) return null;

  const values = [];
  const suitCount = { spades: 0, hearts: 0, diamonds: 0, clubs: 0 };
  const suitValues = { spades: [], hearts: [], diamonds: [], clubs: [] };
  const rankCount = new Map();

  for (const c of cards) {
    const v = RANK_VALUE[c.rank];
    if (!v) return null;
    values.push(v);
    suitCount[c.suit] = (suitCount[c.suit] || 0) + 1;
    if (suitValues[c.suit]) suitValues[c.suit].push(v);
    rankCount.set(v, (rankCount.get(v) || 0) + 1);
  }

  // 按 [次数, 点数] 降序分组
  const groups = [...rankCount.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);

  const allDesc = [...values].sort((a, b) => b - a);

  // 同花：找出 >=5 张的花色
  let flushSuit = null;
  for (const suit of Object.keys(suitCount)) {
    if (suitCount[suit] >= 5) {
      flushSuit = suit;
      break;
    }
  }

  // 同花顺 / 皇家同花顺
  if (flushSuit) {
    const flushValues = suitValues[flushSuit].slice().sort((a, b) => b - a);
    // 用掩码找该花色的最高顺子
    let mask = 0;
    for (const v of flushValues) mask |= 1 << (v - 2);
    const sfHigh = straightHighFromMask(mask);
    if (sfHigh === 14) {
      return { rank: HAND_RANK.ROYAL_FLUSH, name: '皇家同花顺', tiebreakers: [] };
    }
    if (sfHigh > 0) {
      return { rank: HAND_RANK.STRAIGHT_FLUSH, name: '同花顺', tiebreakers: [sfHigh] };
    }
  }

  // 四条
  if (groups[0].count === 4) {
    const quad = groups[0].value;
    const kicker = allDesc.find(v => v !== quad);
    return { rank: HAND_RANK.FOUR_OF_A_KIND, name: '四条', tiebreakers: [quad, kicker] };
  }

  // 葫芦：三条 + 一对（7 张里可能有多个三条）
  if (groups[0].count === 3 && groups[1] && groups[1].count >= 2) {
    const trips = groups[0].value;
    // 对子取除三条外最大的、出现 >=2 次的点数
    const pair = groups.find(g => g.value !== trips && g.count >= 2).value;
    return { rank: HAND_RANK.FULL_HOUSE, name: '葫芦', tiebreakers: [trips, pair] };
  }

  // 同花：取该花色最大的 5 张
  if (flushSuit) {
    const flushValues = suitValues[flushSuit].slice().sort((a, b) => b - a);
    return { rank: HAND_RANK.FLUSH, name: '同花', tiebreakers: topN(flushValues, 5) };
  }

  // 顺子
  {
    let mask = 0;
    for (const v of allDesc) mask |= 1 << (v - 2);
    const high = straightHighFromMask(mask);
    if (high > 0) {
      return { rank: HAND_RANK.STRAIGHT, name: '顺子', tiebreakers: [high] };
    }
  }

  // 三条
  if (groups[0].count === 3) {
    const trips = groups[0].value;
    const kickers = allDesc.filter(v => v !== trips).slice(0, 2);
    return { rank: HAND_RANK.THREE_OF_A_KIND, name: '三条', tiebreakers: [trips, ...kickers] };
  }

  // 两对（可能有三个对子，取最大两个）
  if (groups[0].count === 2 && groups[1] && groups[1].count === 2) {
    const pairs = groups.filter(g => g.count === 2).map(g => g.value).sort((a, b) => b - a);
    const highPair = pairs[0];
    const lowPair = pairs[1];
    const kicker = allDesc.find(v => v !== highPair && v !== lowPair);
    return { rank: HAND_RANK.TWO_PAIR, name: '两对', tiebreakers: [highPair, lowPair, kicker] };
  }

  // 一对
  if (groups[0].count === 2) {
    const pair = groups[0].value;
    const kickers = allDesc.filter(v => v !== pair).slice(0, 3);
    return { rank: HAND_RANK.ONE_PAIR, name: '一对', tiebreakers: [pair, ...kickers] };
  }

  // 高牌
  return { rank: HAND_RANK.HIGH_CARD, name: '高牌', tiebreakers: topN(allDesc, 5) };
}

module.exports = { evaluate7, RANK_VALUE };
