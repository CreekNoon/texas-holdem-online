// 机器人决策（PRD-03 §4）
//
// 安全约束：decide() 的入参只包含公共信息 + 自己的底牌，绝不接收他人底牌。
const { equity } = require('./equity');

// 翻牌前简化起手牌分级
const PREMIUM_PAIRS = new Set(['A', 'K', 'Q', 'J']);
const STRONG_AX = new Set(['A', 'K']);

function rankOf(card) {
  return card.rank;
}

// 把两张底牌映射成 0–1 的强度分（粗粒度，够用即可）
function preflopStrength(hole) {
  const [a, b] = hole.map(rankOf);
  const val = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  const hi = Math.max(val[a], val[b]);
  const lo = Math.min(val[a], val[b]);
  const isPair = a === b;
  const isSuited = hole[0].suit === hole[1].suit;
  const gap = hi - lo;

  let score = 0;
  if (isPair) {
    score = 0.5 + (hi - 2) / 12 * 0.45; // 22 → 0.5, AA → 0.95
  } else {
    score = 0.15 + (hi - 2) / 12 * 0.45 + (lo - 2) / 12 * 0.2;
    if (isSuited) score += 0.06;
    if (gap <= 2) score += 0.05;
    if (gap > 5) score -= 0.05;
    if (hi === 14) score += 0.04;
  }
  return Math.max(0.02, Math.min(0.98, score));
}

function clampRaise(amount, state, self) {
  const minTotal = state.currentBet + (state.minRaiseTo - state.currentBet || state.bigBlind);
  const maxTotal = self.currentBet + self.chips;
  return Math.max(minTotal, Math.min(Math.floor(amount), maxTotal));
}

class BotBrain {
  constructor(profile = {}) {
    this.difficulty = profile.difficulty || 'normal';
    // profile 随机化：激进度/诈唬率浮动 ±20%（PRD-03 §9）
    this.aggression = (profile.aggression || 1) * (0.8 + Math.random() * 0.4);
    this.bluffRate = (profile.bluffRate || 0.1) * (0.8 + Math.random() * 0.4);
    this.name = profile.name || 'Bot';
  }

  // state: 公共状态（不含他人底牌）；self: 自己（含底牌）；equityResult: 可选，外部注入避免重复计算
  decide({ state, self, equityResult }) {
    const callAmount = Math.max(0, state.currentBet - self.currentBet);
    const pot = state.pot;
    const canCheck = callAmount === 0;

    // 短筹码 push/fold（< 10BB）
    const bb = state.bigBlind || 20;
    const isShortStack = self.chips <= bb * 10;

    let strength;
    if (state.stage === 'preflop') {
      strength = preflopStrength(self.hand);
    } else {
      const eq = equityResult || equity({
        hole: self.hand,
        board: state.community,
        opponents: Math.max(1, state.players.filter(p => !p.folded && p.id !== self.id).length),
        iterations: 800
      });
      strength = eq.equity;
    }

    const potOdds = callAmount > 0 ? callAmount / (pot + callAmount) : 0;
    const roll = Math.random();

    // ===== 简单 =====
    if (this.difficulty === 'easy') {
      if (strength < 0.25) return { action: 'fold' };
      if (strength > 0.75 && roll < 0.5 * this.aggression) {
        return { action: 'raise', amount: clampRaise(state.currentBet + pot * 0.5, state, self) };
      }
      if (strength > 0.55) return { action: canCheck ? 'check' : 'call' };
      return { action: canCheck ? 'check' : 'fold' };
    }

    // ===== 困难 =====
    if (this.difficulty === 'hard') {
      if (isShortStack) {
        if (strength > 0.6) return { action: 'allin' };
        return { action: canCheck ? 'check' : 'fold' };
      }
      // 听牌半诈唬
      const hasDraw = strength > 0.3 && strength < 0.55 && state.stage !== 'preflop';
      if (hasDraw && roll < this.bluffRate * 1.5) {
        return { action: 'raise', amount: clampRaise(state.currentBet + pot * 0.6, state, self) };
      }
      if (strength > potOdds + 0.2) {
        const sizing = [0.5, 0.66, 1.0][Math.floor(Math.random() * 3)];
        return { action: 'raise', amount: clampRaise(state.currentBet + pot * sizing, state, self) };
      }
      if (strength > potOdds + 0.05) return { action: canCheck ? 'check' : 'call' };
      if (canCheck) return { action: 'check' };
      return { action: 'fold' };
    }

    // ===== 普通（默认）=====
    if (isShortStack) {
      if (strength > 0.65) return { action: 'allin' };
      if (strength < 0.3) return { action: canCheck ? 'check' : 'fold' };
    }

    if (strength > potOdds + 0.2) {
      return { action: 'raise', amount: clampRaise(state.currentBet + pot * 0.6, state, self) };
    }
    if (strength > potOdds + 0.05) {
      return { action: canCheck ? 'check' : 'call' };
    }
    // 诈唬
    if (canCheck && roll < this.bluffRate) {
      return { action: 'raise', amount: clampRaise(state.currentBet + pot * 0.5, state, self) };
    }
    return { action: canCheck ? 'check' : 'fold' };
  }
}

module.exports = { BotBrain, preflopStrength };
