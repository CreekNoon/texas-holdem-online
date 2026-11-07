// 蒙特卡洛胜率引擎（PRD-03 §3.1）
const { evaluate7 } = require('./evaluator7');
const { compareHands } = require('./handEvaluator');

const ALL_CARDS = (() => {
  const suits = ['spades', 'hearts', 'diamonds', 'clubs'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  const cards = [];
  for (const suit of suits) for (const rank of ranks) cards.push({ suit, rank });
  return cards;
})();

const cardKey = (c) => `${c.suit}:${c.rank}`;

// 简单 LRU
class LRU {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get(key) {
    if (!this.map.has(key)) return undefined;
    const v = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }
  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.max) {
      this.map.delete(this.map.keys().next().value);
    }
  }
  clear() {
    this.map.clear();
  }
  get size() {
    return this.map.size;
  }
}

const cache = new LRU(500);

function sortKey(cards) {
  return cards.map(cardKey).sort().join('|');
}

// equity({ hole, board, opponents }) 或 equity({ hole, board, opponentHands })
function equity(options = {}) {
  const {
    hole,
    board = [],
    opponents,
    opponentHands,
    iterations = 3000,
    useCache = true
  } = options;

  if (!Array.isArray(hole) || hole.length !== 2) {
    throw new Error('hole 必须是 2 张底牌');
  }
  if (!Array.isArray(board) || board.length > 5) {
    throw new Error('board 必须是 0–5 张公共牌');
  }

  const knownOpponentHands = opponentHands || null;
  let oppCount;

  if (knownOpponentHands) {
    if (!Array.isArray(knownOpponentHands) || knownOpponentHands.length === 0) {
      throw new Error('opponentHands 必须是非空数组');
    }
    if (knownOpponentHands.some(h => !Array.isArray(h) || h.length !== 2)) {
      throw new Error('opponentHands 中每个元素必须是 2 张底牌');
    }
    oppCount = knownOpponentHands.length;
  } else {
    oppCount = opponents;
    if (!Number.isInteger(oppCount) || oppCount < 1 || oppCount > 6) {
      throw new Error('opponents 必须是 1–6 的整数');
    }
  }

  const cacheKey = [
    sortKey(hole),
    sortKey(board),
    knownOpponentHands ? knownOpponentHands.map(sortKey).sort().join(';') : `n${oppCount}`,
    iterations
  ].join('||');

  if (useCache) {
    const hit = cache.get(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  // 已用牌
  const used = new Set();
  for (const c of [...hole, ...board]) used.add(cardKey(c));
  if (knownOpponentHands) {
    for (const h of knownOpponentHands) for (const c of h) used.add(cardKey(c));
  }

  // 重复牌检查
  const usedCount = new Set();
  let dup = false;
  for (const c of [...hole, ...board, ...(knownOpponentHands ? knownOpponentHands.flat() : [])]) {
    const k = cardKey(c);
    if (usedCount.has(k)) dup = true;
    usedCount.add(k);
  }
  if (dup) throw new Error('存在重复牌');

  const deck = ALL_CARDS.filter(c => !used.has(cardKey(c)));

  const neededBoard = 5 - board.length;
  const needRandomOpponents = knownOpponentHands ? 0 : oppCount;

  if (deck.length < neededBoard + needRandomOpponents * 2) {
    throw new Error('剩余牌不足以完成模拟');
  }

  let win = 0;
  let tie = 0;
  let lose = 0;

  const n = iterations;
  for (let i = 0; i < n; i++) {
    // 部分洗牌：只抽需要的张数
    const pool = deck.slice();
    const totalNeeded = neededBoard + needRandomOpponents * 2;
    for (let j = 0; j < totalNeeded; j++) {
      const k = j + Math.floor(Math.random() * (pool.length - j));
      [pool[j], pool[k]] = [pool[k], pool[j]];
    }

    let cursor = 0;
    const fullBoard = board.concat(pool.slice(cursor, cursor + neededBoard));
    cursor += neededBoard;

    const myHand = evaluate7([...hole, ...fullBoard]);

    let best = myHand;
    let bestIsMe = true;
    let tiedWithMe = false;

    if (knownOpponentHands) {
      for (const h of knownOpponentHands) {
        const opp = evaluate7([...h, ...fullBoard]);
        const cmp = compareHands(opp, best);
        if (cmp > 0) { best = opp; bestIsMe = false; tiedWithMe = false; }
        else if (cmp === 0) { tiedWithMe = true; }
      }
    } else {
      for (let o = 0; o < needRandomOpponents; o++) {
        const oppHole = pool.slice(cursor, cursor + 2);
        cursor += 2;
        const opp = evaluate7([...oppHole, ...fullBoard]);
        const cmp = compareHands(opp, best);
        if (cmp > 0) { best = opp; bestIsMe = false; tiedWithMe = false; }
        else if (cmp === 0) { tiedWithMe = true; }
      }
    }

    if (bestIsMe && !tiedWithMe) win++;
    else if (bestIsMe && tiedWithMe) tie++;
    else if (!bestIsMe && compareHands(myHand, best) === 0) tie++;
    else lose++;
  }

  const result = {
    win: win / n,
    tie: tie / n,
    lose: lose / n,
    equity: (win + tie / 2) / n,
    iterations: n
  };

  if (useCache) cache.set(cacheKey, result);
  return { ...result, cached: false };
}

function clearEquityCache() {
  cache.clear();
}

module.exports = { equity, clearEquityCache, ALL_CARDS, cardKey };
