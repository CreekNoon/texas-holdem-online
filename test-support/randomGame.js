const PokerGame = require('../game/pokerGame');

// 可复现的伪随机（避免测试偶发失败时无法定位）
function makeRandom(seed) {
  let s = seed >>> 0;
  return function random() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(random, arr) {
  return arr[Math.floor(random() * arr.length)];
}

function randInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

// 快照当前所有不变量需要的数据
function snapshot(game) {
  return {
    stage: game.stage,
    pot: game.pot,
    chips: game.players.reduce((a, p) => a + p.chips, 0),
    totalBet: game.players.reduce((a, p) => a + p.totalBet, 0),
    players: game.players.length
  };
}

// 断言一条不变量，返回错误信息或 null
function checkInvariants(game, initialChips) {
  const chips = game.players.reduce((a, p) => a + p.chips, 0);
  const totalBet = game.players.reduce((a, p) => a + p.totalBet, 0);
  const withdrawn = game.withdrawnChips || 0;

  // 离桌玩家带走的筹码计入 withdrawnChips，因此守恒式包含它
  if (chips + game.pot + withdrawn !== initialChips) {
    return `筹码不守恒: chips=${chips} pot=${game.pot} withdrawn=${withdrawn} initial=${initialChips}`;
  }

  if (['preflop', 'flop', 'turn', 'river'].includes(game.stage) && game.pot !== totalBet) {
    return `底池与总投入不一致: pot=${game.pot} totalBet=${totalBet}`;
  }

  if (game.stage === 'ended') {
    if (game.pot !== 0) return `结束后底池未清零: pot=${game.pot}`;
    if (chips + withdrawn !== initialChips) {
      return `结束后筹码不守恒: chips=${chips} withdrawn=${withdrawn} initial=${initialChips}`;
    }
  }

  // 索引合法性
  if (game.players.length > 0) {
    if (game.currentPlayerIndex < 0 || game.currentPlayerIndex >= game.players.length) {
      return `currentPlayerIndex 越界: ${game.currentPlayerIndex}/${game.players.length}`;
    }
    if (game.buttonIndex < 0 || game.buttonIndex >= game.players.length) {
      return `buttonIndex 越界: ${game.buttonIndex}/${game.players.length}`;
    }
  }

  // 牌唯一
  const seen = new Set();
  const allCards = [...game.community];
  for (const p of game.players) allCards.push(...p.hand);
  for (const c of allCards) {
    const key = `${c.suit}:${c.rank}`;
    if (seen.has(key)) return `重复牌: ${key}`;
    seen.add(key);
  }

  return null;
}

// 跑一局随机牌局，返回 { error, game, initialChips, actions }
function playRandomHand(options = {}) {
  const {
    seed = Math.floor(Math.random() * 2 ** 32),
    playerCount,
    startingChips,
    maxSteps = 500,
    includeLeave = true
  } = options;

  const random = makeRandom(seed);
  const n = playerCount || randInt(random, 2, 7);
  const chips = startingChips || pick(random, [20, 50, 100, 500, 1000, 2000]);

  const game = new PokerGame('random', { startingChips: chips });
  for (let i = 0; i < n; i++) {
    game.addPlayer(`P${i}`, `P${i}`, null);
  }

  // 随机让部分座位破产（覆盖“破产座位”场景）
  if (random() < 0.2) {
    for (let i = 0; i < n; i++) {
      if (random() < 0.3) game.players[i].chips = 0;
    }
  }

  game.stage = 'ended';
  const initialChips = game.players.reduce((a, p) => a + p.chips, 0);
  if (!game.startHand()) {
    return { error: null, game, initialChips, skipped: true, actions: 0 };
  }

  let steps = 0;
  while (['preflop', 'flop', 'turn', 'river'].includes(game.stage) && steps < maxSteps) {
    steps++;

    const cur = game.players[game.currentPlayerIndex];
    if (!cur) return { error: '当前玩家不存在', game, initialChips, actions: steps };

    const callAmount = Math.max(0, game.currentBet - cur.currentBet);
    const maxTotal = cur.currentBet + cur.chips;

    let action;
    let amount = 0;
    const roll = random();

    if (callAmount === 0) {
      action = roll < 0.15 ? 'fold' : roll < 0.5 ? 'check' : roll < 0.75 ? 'raise' : 'allin';
    } else {
      action = roll < 0.2 ? 'fold' : roll < 0.55 ? 'call' : roll < 0.8 ? 'raise' : 'allin';
    }

    if (action === 'raise') {
      const minTotal = game.currentBet + game.minRaise;
      if (minTotal > maxTotal) {
        action = callAmount === 0 ? 'check' : 'call';
      } else {
        // 覆盖最小值、最大值、随机值
        const mode = random();
        if (mode < 0.3) amount = minTotal;
        else if (mode < 0.5) amount = maxTotal;
        else amount = randInt(random, minTotal, maxTotal);
      }
    }

    // 偶尔注入非法动作，验证不会被接受
    if (random() < 0.05) {
      game.playerAction(cur.id, 'raise', pick(random, [NaN, Infinity, -1, 0, 1.5, 'abc', null, undefined]));
    }

    if (!game.playerAction(cur.id, action, amount)) {
      const fallback = callAmount === 0 ? 'check' : 'fold';
      if (!game.playerAction(cur.id, fallback, 0)) break;
    }

    const err = checkInvariants(game, initialChips);
    if (err) return { error: err, game, initialChips, actions: steps };

    // 牌局中随机有人离开（覆盖“保留座位”策略）
    if (includeLeave && random() < 0.05) {
      const target = pick(random, game.players.filter(p => !p.folded && !p.allIn));
      if (target) game.markFolded(target.id);
      const err2 = checkInvariants(game, initialChips);
      if (err2) return { error: err2, game, initialChips, actions: steps };
    }
  }

  const err = checkInvariants(game, initialChips);
  return { error: err, game, initialChips, actions: steps };
}

module.exports = { makeRandom, pick, randInt, snapshot, checkInvariants, playRandomHand };
