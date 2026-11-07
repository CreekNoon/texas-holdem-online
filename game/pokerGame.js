const { Deck } = require('./deck');
const { evaluateBest, compareHands } = require('./handEvaluator');
const crypto = require('node:crypto');

const VALID_ACTIONS = new Set(['fold', 'check', 'call', 'raise', 'allin']);
const MAX_PLAYERS = 7;

function newPlayerId() {
  return 'p_' + crypto.randomUUID();
}

function newToken() {
  return crypto.randomBytes(16).toString('hex');
}

class PokerGame {
  constructor(roomId, config = {}) {
    this.roomId = roomId;
    this.players = []; // {id, name, socketId, token, chips, hand, folded, allIn, currentBet, totalBet, hasActed, isBot, disconnected}
    this.deck = null;
    this.community = [];
    this.pot = 0;
    this.currentBet = 0; // 当前轮最高下注
    this.minRaise = 0;
    this.stage = 'waiting'; // waiting, preflop, flop, turn, river, showdown, ended
    this.buttonIndex = 0; // 庄家位
    this.currentPlayerIndex = 0;
    this.smallBlind = config.smallBlind || 10;
    this.bigBlind = config.bigBlind || 20;
    this.startingChips = config.startingChips || 1000;
    this.lastRaiserIndex = -1;
    this.winners = [];
    this.result = null;
    this.wentToShowdown = false; // 是否真正进入摊牌（决定底牌可见性）
    this.withdrawnChips = 0; // 离桌玩家带走的筹码（不参与底池，但参与全局守恒）
    this.sbIndex = -1;
    this.bbIndex = -1;
    this.log = [];
    this.handCount = 0;

    // 回合超时（PRD-02）
    this.turnTimeMs = config.turnTimeMs || 30000;
    this.turnDeadline = null;
    this.turnSeq = 0; // 每次行动者/阶段变化 +1，网络层据此判断是否重置计时器
  }

  isHandInProgress() {
    return this.stage !== 'waiting' && this.stage !== 'ended';
  }

  // 标记行动者/阶段发生变化，供网络层重置回合计时器（PRD-02 §4.1）
  bumpTurnSeq() {
    this.turnSeq++;
    return this.turnSeq;
  }

  // 当前是否轮到某个玩家行动（且阶段需要计时）
  // 注意：这是“人类超时计时器”的判据，bot 回合由 BotScheduler 负责，不计时
  isTurnActive() {
    if (!this.isActionPhase()) return false;
    const cur = this.players[this.currentPlayerIndex];
    if (!cur) return false;
    if (cur.folded || cur.allIn || cur.disconnected || cur.isBot) return false;
    return true;
  }

  // 当前是否处于“有人需要行动”的阶段（不区分人/机器人）
  isActionPhase() {
    if (!['preflop', 'flop', 'turn', 'river'].includes(this.stage)) return false;
    const cur = this.players[this.currentPlayerIndex];
    if (!cur) return false;
    return !cur.folded && !cur.allIn;
  }

  addPlayer(id, name, socket) {
    // 牌局进行中禁止新玩家加入（PRD-01 §3.2）
    if (this.isHandInProgress()) return null;
    // 同一 playerId 不允许重复占座
    if (this.players.some(p => p.id === id)) return null;

    if (this.players.length >= MAX_PLAYERS) {
      // 满座时优先替换破产座位（PRD-01 §3.9）
      const broke = this.players.find(p => p.chips <= 0 && !p.disconnected);
      if (!broke) return null;
      this.removePlayer(broke.id);
    }

    const player = {
      id, name,
      socketId: socket && socket.id ? socket.id : null,
      token: newToken(),
      chips: this.startingChips,
      hand: [],
      folded: false,
      allIn: false,
      currentBet: 0,
      totalBet: 0,
      hasActed: false,
      chipsAtHandStart: this.startingChips,
      isBot: false,
      ready: false,
      disconnected: false,
      disconnectedAt: null
    };
    this.players.push(player);
    return player;
  }

  // 添加机器人（PRD-03 §4.3）
  // 机器人不占“真人上限”，但总座位仍 ≤ MAX_PLAYERS
  addBot(name, options = {}) {
    if (this.isHandInProgress()) return null;
    if (this.players.length >= MAX_PLAYERS) {
      const broke = this.players.find(p => p.chips <= 0 && !p.disconnected);
      if (!broke) return null;
      this.removePlayer(broke.id);
    }

    const id = 'bot_' + crypto.randomUUID();
    const player = {
      id,
      name: name || `机器人${this.players.filter(p => p.isBot).length + 1}`,
      socketId: null,
      token: null,
      chips: this.startingChips,
      hand: [],
      folded: false,
      allIn: false,
      currentBet: 0,
      totalBet: 0,
      hasActed: false,
      chipsAtHandStart: this.startingChips,
      isBot: true,
      ready: true, // 机器人总是已准备
      botDifficulty: options.difficulty || 'normal',
      disconnected: false,
      disconnectedAt: null
    };
    this.players.push(player);
    return player;
  }

  // 训练模式：补足机器人到指定数量
  fillWithBots(targetCount, difficulty = 'normal') {
    const added = [];
    while (this.players.length < Math.min(targetCount, MAX_PLAYERS)) {
      const bot = this.addBot(null, { difficulty });
      if (!bot) break;
      added.push(bot);
    }
    return added;
  }

  // 重置筹码（训练模式用）
  resetChips(chips) {
    const value = Number.isSafeInteger(chips) && chips > 0 ? chips : this.startingChips;
    for (const p of this.players) {
      p.chips = value;
      p.chipsAtHandStart = value;
    }
    this.withdrawnChips = 0;
  }

  // 绑定/解绑 socket（PRD-02 §3.3）
  setPlayerConnection(id, socketId, connected) {
    const player = this.players.find(p => p.id === id);
    if (!player) return null;
    player.socketId = connected ? socketId : null;
    player.disconnected = !connected;
    player.disconnectedAt = connected ? null : Date.now();
    this.bumpTurnSeq();
    return player;
  }

  // 按 token 查找玩家（重连校验）
  findPlayerByToken(id, token) {
    const player = this.players.find(p => p.id === id);
    if (!player || !token) return null;
    // 定长比较，避免时序侧信道
    const a = Buffer.from(String(player.token));
    const b = Buffer.from(String(token));
    if (a.length !== b.length) return null;
    if (!crypto.timingSafeEqual(a, b)) return null;
    return player;
  }

  // 重连成功后轮换 token，旧 token 立即失效（PRD-02 §9）
  rotateToken(id) {
    const player = this.players.find(p => p.id === id);
    if (!player) return null;
    player.token = newToken();
    return player.token;
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx < 0) return;

    // 离桌玩家把剩余筹码带走，记入 withdrawnChips 以保证全局筹码守恒可核算
    const leaving = this.players[idx];
    if (leaving.chips > 0) this.withdrawnChips += leaving.chips;

    this.players.splice(idx, 1);
    const n = this.players.length;
    if (n === 0) {
      this.currentPlayerIndex = 0;
      this.buttonIndex = 0;
      return;
    }

    // 修正当前行动者索引，避免越界或跳人（PRD-01 §3.5）
    if (idx < this.currentPlayerIndex) this.currentPlayerIndex--;
    else if (idx === this.currentPlayerIndex) this.currentPlayerIndex = idx % n;
    if (this.currentPlayerIndex >= n) this.currentPlayerIndex = 0;

    // 修正按钮位
    if (idx < this.buttonIndex) this.buttonIndex--;
    else if (idx === this.buttonIndex) this.buttonIndex = idx % n;
    if (this.buttonIndex >= n) this.buttonIndex = 0;
  }

  // 断线：标记弃牌但保留座位到本局结束（PRD-01 §3.5）
  // 注意：PRD-02 引入宽限期后，disconnect 走 markDisconnected()，不走这里；
  // 显式 leave 仍走 markFolded() 立即弃牌。
  markFolded(id) {
    const player = this.players.find(p => p.id === id);
    if (!player) return false;

    // 已 all-in 的玩家筹码已进池，断线不弃牌
    if (player.allIn) {
      player.disconnected = true;
      return true;
    }

    const wasActive = !player.folded;
    player.folded = true;
    player.disconnected = true;

    const current = this.players[this.currentPlayerIndex];
    if (wasActive && this.isHandInProgress() && current && current.id === id) {
      this.checkRoundEnd();
    }
    return true;
  }

  // 断线（PRD-02）：只标记 disconnected，保留座位与手牌，不立即弃牌
  markDisconnected(id) {
    const player = this.players.find(p => p.id === id);
    if (!player) return false;
    player.disconnected = true;
    player.disconnectedAt = Date.now();
    player.socketId = null;
    this.bumpTurnSeq();
    return true;
  }

  // 宽限期到期：此时才真正弃牌（PRD-02 §3.3）
  foldDisconnectedPlayer(id) {
    const player = this.players.find(p => p.id === id);
    if (!player || !player.disconnected) return false;

    // 已 all-in：筹码已进池，只等结算
    if (player.allIn) return true;
    if (player.folded) return true;

    player.folded = true;
    this.addLog(`${player.name} 断线超时，本局弃牌`);

    const current = this.players[this.currentPlayerIndex];
    if (this.isHandInProgress() && current && current.id === id) {
      this.checkRoundEnd();
    } else {
      this.bumpTurnSeq();
    }
    return true;
  }

  // 本局结束后才真正移除断线玩家
  removeDisconnectedPlayers() {
    for (const p of [...this.players]) {
      if (p.disconnected) this.removePlayer(p.id);
    }
  }

  getActivePlayers() {
    return this.players.filter(p => !p.folded && !p.disconnected);
  }

  getPlayersInHand() {
    return this.players.filter(p => !p.folded);
  }

  // 获取可继续游戏的玩家（有筹码或未弃牌）
  getEligiblePlayers() {
    return this.players.filter(p => p.chips > 0);
  }

  // 有效按钮位：从 buttonIndex 起第一个有筹码的玩家
  getEffectiveButtonIndex() {
    const n = this.players.length;
    for (let i = 0; i < n; i++) {
      const idx = (this.buttonIndex + i) % n;
      if (this.players[idx].chips > 0) return idx;
    }
    return this.buttonIndex;
  }

  addLog(msg) {
    this.log.push(msg);
    if (this.log.length > 50) this.log.shift();
  }

  startHand() {
    const eligible = this.getEligiblePlayers();
    if (eligible.length < 2) {
      this.addLog('至少需要 2 名玩家才能开始');
      return false;
    }
    // 只有当处于 waiting 或 ended 状态才能开始
    if (this.stage !== 'waiting' && this.stage !== 'ended') return false;

    this.handCount++;
    this.deck = new Deck();
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    this.winners = [];
    this.result = null;
    this.wentToShowdown = false;
    this.stage = 'preflop';

    // 重置玩家状态（没筹码的玩家视为已坐下等待，不参与本局）
    for (const p of this.players) {
      p.hand = [];
      p.folded = p.chips <= 0;
      p.allIn = false;
      p.currentBet = 0;
      p.totalBet = 0;
      p.hasActed = false;
      p.chipsAtHandStart = p.chips;
    }

    // 发底牌
    for (let i = 0; i < 2; i++) {
      for (const p of eligible) {
        p.hand.push(this.deck.deal());
      }
    }

    // 按庄家位顺时针排列有筹码的玩家
    const n = this.players.length;
    const order = [];
    for (let i = 0; i < n; i++) {
      const idx = (this.buttonIndex + i) % n;
      if (this.players[idx].chips > 0) order.push(idx);
    }
    const activeCount = order.length;

    // 盲注与首位行动者
    let sbIdx, bbIdx, firstIdx;
    if (activeCount === 2) {
      // 单挑：庄家即小盲
      sbIdx = order[0];
      bbIdx = order[1];
      firstIdx = order[0];
    } else {
      sbIdx = order[1];
      bbIdx = order[2];
      firstIdx = order[3 % activeCount];
    }

    const sb = this.players[sbIdx];
    const bb = this.players[bbIdx];

    this.placeBet(sb, Math.min(this.smallBlind, sb.chips));
    this.placeBet(bb, Math.min(this.bigBlind, bb.chips));
    this.currentBet = this.bigBlind;
    this.minRaise = this.bigBlind;

    this.sbIndex = sbIdx;
    this.bbIndex = bbIdx;
    this.currentPlayerIndex = firstIdx;
    this.lastRaiserIndex = bbIdx;
    // 首位行动者若是短筹码 all-in，跳到下一位
    if (this.players[firstIdx].allIn) this.nextPlayer();

    this.addLog(`第 ${this.handCount} 局开始，盲注 ${this.smallBlind}/${this.bigBlind}`);
    this.addLog(`${sb.name} 下小盲 ${this.smallBlind}，${bb.name} 下大盲 ${this.bigBlind}`);

    // 极端情况：只剩一人可继续
    if (this.getPlayersInHand().length <= 1) {
      this.endHand();
    } else if (!this.getPlayersInHand().some(p => !p.allIn)) {
      // 所有人 all-in，直接发完公共牌
      this.advanceStage();
    }
    return true;
  }

  placeBet(player, amount) {
    // 先校验再 clamp：Math.max(0, Math.min(NaN, chips)) 仍然是 NaN
    if (!Number.isSafeInteger(amount) || amount < 0) return 0;
    const actual = Math.min(amount, player.chips);
    if (!Number.isSafeInteger(actual) || actual < 0) return 0;
    player.chips -= actual;
    player.currentBet += actual;
    player.totalBet += actual;
    this.pot += actual;
    if (player.chips === 0) {
      player.allIn = true;
    }
    return actual;
  }

  // 玩家行动
  playerAction(playerId, action, amount = 0) {
    if (!VALID_ACTIONS.has(action)) return false;

    const player = this.players.find(p => p.id === playerId);
    if (!player || player.folded || player.allIn) return false;

    const current = this.players[this.currentPlayerIndex];
    if (!current || current.id !== playerId) return false;
    if (this.stage === 'showdown' || this.stage === 'ended' || this.stage === 'waiting') return false;

    if (action === 'raise') {
      if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount <= 0) return false;
    }

    const callAmount = this.currentBet - player.currentBet;

    switch (action) {
      case 'fold':
        player.folded = true;
        this.addLog(`${player.name} 弃牌`);
        break;
      case 'check':
        if (callAmount > 0) return false;
        player.hasActed = true;
        this.addLog(`${player.name} 过牌`);
        break;
      case 'call':
        if (callAmount <= 0) return false;
        const called = this.placeBet(player, callAmount);
        player.hasActed = true;
        this.addLog(`${player.name} 跟注 ${called}`);
        break;
      case 'raise':
        // amount 是新的总下注额（该轮）
        const minTotal = this.currentBet + this.minRaise;
        let raiseTotal = Math.max(amount, minTotal);
        // 不能超过筹码
        const maxBet = player.currentBet + player.chips;
        raiseTotal = Math.min(raiseTotal, maxBet);

        const raiseAmount = raiseTotal - player.currentBet;
        if (raiseAmount <= callAmount) return false; // 必须大于跟注额才算加注

        this.placeBet(player, raiseAmount);
        // 更新最小加注额
        this.minRaise = Math.max(this.minRaise, raiseTotal - this.currentBet);
        this.currentBet = raiseTotal;
        this.lastRaiserIndex = this.players.indexOf(player);
        // 重置其他未弃牌玩家的 hasActed
        for (const p of this.players) {
          if (!p.folded && !p.allIn && p.id !== player.id) p.hasActed = false;
        }
        player.hasActed = true;
        this.addLog(`${player.name} 加注到 ${raiseTotal}`);
        break;
      case 'allin':
        if (player.chips <= 0) return false;
        const allInAmount = player.chips;
        this.placeBet(player, allInAmount);
        const newTotal = player.currentBet;
        if (newTotal > this.currentBet) {
          this.minRaise = Math.max(this.minRaise, newTotal - this.currentBet);
          this.currentBet = newTotal;
          this.lastRaiserIndex = this.players.indexOf(player);
          for (const p of this.players) {
            if (!p.folded && !p.allIn && p.id !== player.id) p.hasActed = false;
          }
        }
        player.hasActed = true;
        this.addLog(`${player.name} 全押 ${allInAmount}`);
        break;
      default:
        return false;
    }

    this.checkRoundEnd();
    return true;
  }

  // 检查当前轮是否结束
  checkRoundEnd() {
    const inHand = this.getPlayersInHand();
    // 只剩一人（或无人），直接结束牌局
    if (inHand.length <= 1) {
      this.endHand();
      return;
    }

    // 检查是否所有未弃牌玩家都已行动且下注相等
    const notAllIn = inHand.filter(p => !p.allIn);
    if (notAllIn.length === 0) {
      // 全部 all-in 或弃牌
      this.advanceStage();
      return;
    }

    const allActed = notAllIn.every(p => p.hasActed);
    const allBetsEqual = notAllIn.every(p => p.currentBet === this.currentBet);

    if (allActed && allBetsEqual) {
      this.advanceStage();
    } else {
      this.nextPlayer();
    }
  }

  nextPlayer() {
    const n = this.players.length;
    let idx = this.currentPlayerIndex;
    for (let i = 0; i < n; i++) {
      idx = (idx + 1) % n;
      const p = this.players[idx];
      if (!p.folded && !p.allIn) {
        this.currentPlayerIndex = idx;
        this.bumpTurnSeq();
        return;
      }
    }
  }

  advanceStage() {
    // 重置每轮下注
    for (const p of this.players) {
      p.currentBet = 0;
      p.hasActed = false;
    }
    this.currentBet = 0;
    this.minRaise = this.bigBlind;

    if (this.stage === 'preflop') {
      // 翻牌：发3张
      this.deck.burn();
      this.community.push(this.deck.deal(), this.deck.deal(), this.deck.deal());
      this.stage = 'flop';
      this.addLog('翻牌：' + this.community.map(c => c.suit + c.rank).join(' '));
    } else if (this.stage === 'flop') {
      this.deck.burn();
      this.community.push(this.deck.deal());
      this.stage = 'turn';
      this.addLog('转牌：' + this.community[3].suit + this.community[3].rank);
    } else if (this.stage === 'turn') {
      this.deck.burn();
      this.community.push(this.deck.deal());
      this.stage = 'river';
      this.addLog('河牌：' + this.community[4].suit + this.community[4].rank);
    } else if (this.stage === 'river') {
      this.stage = 'showdown';
      this.showdown();
      return;
    }

    // 设置下一轮起始玩家：有效按钮位之后第一位未弃牌玩家
    const n = this.players.length;
    const btn = this.getEffectiveButtonIndex();
    let startIdx = (btn + 1) % n;
    for (let i = 0; i < n; i++) {
      const idx = (startIdx + i) % n;
      if (!this.players[idx].folded && !this.players[idx].allIn) {
        this.currentPlayerIndex = idx;
        break;
      }
    }

    // 如果该轮没有需要行动的玩家（全部 all-in），直接推进
    const needAction = this.players.some(p => !p.folded && !p.allIn);
    if (!needAction) {
      this.advanceStage();
    } else {
      this.bumpTurnSeq();
    }
  }

  // 按“所有玩家的总投入层级”建池（PRD-01 §3.1）
  buildPots() {
    const levels = [...new Set(
      this.players.filter(p => p.totalBet > 0).map(p => p.totalBet)
    )].sort((a, b) => a - b);

    let prev = 0;
    const pots = [];
    for (const level of levels) {
      const diff = level - prev;
      const contributors = this.players.filter(p => p.totalBet >= level);
      pots.push({ amount: diff * contributors.length, contributors, level, diff });
      prev = level;
    }
    return pots;
  }

  // 建池 + 结算：showdown 与 endHand 共用同一套逻辑
  // 退款（未被跟注的超额 / 无人存活的层）单独记账，绝不进入 winners
  settle() {
    const pots = this.buildPots();
    const refunds = {};
    const payouts = {};
    const playerHands = {};

    if (this.wentToShowdown) {
      for (const p of this.players) {
        if (!p.folded && p.hand.length === 2) {
          // withCards: true → 结算快照需要最佳五张（PRD-04 §3.5）
          playerHands[p.id] = evaluateBest([...p.hand, ...this.community], { withCards: true });
        }
      }
    }

    for (const pot of pots) {
      // 该层只有一个贡献者 = 未被跟注的超额，原路退还（即使已弃牌）
      if (pot.contributors.length === 1) {
        const p = pot.contributors[0];
        refunds[p.id] = (refunds[p.id] || 0) + pot.amount;
        continue;
      }

      const eligible = pot.contributors.filter(p => !p.folded);

      // 该层没有未弃牌候选：按各自投入原路退回，不得丢弃
      if (eligible.length === 0) {
        for (const p of pot.contributors) {
          refunds[p.id] = (refunds[p.id] || 0) + pot.diff;
        }
        continue;
      }

      let winners;
      if (this.wentToShowdown) {
        let bestHand = null;
        winners = [];
        for (const p of eligible) {
          const h = playerHands[p.id];
          if (!bestHand || compareHands(h, bestHand) > 0) {
            bestHand = h;
            winners = [p];
          } else if (compareHands(h, bestHand) === 0) {
            winners.push(p);
          }
        }
      } else {
        // endHand：未弃牌者即赢家
        winners = eligible;
      }

      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;
      for (let i = 0; i < winners.length; i++) {
        const w = winners[i];
        payouts[w.id] = (payouts[w.id] || 0) + share + (i < remainder ? 1 : 0);
      }
    }

    return { pots, refunds, payouts, playerHands };
  }

  // 只动筹码，不碰 winners：退款与赢池在可见性层面必须分开
  applyChips(refunds, payouts) {
    for (const [pid, amount] of Object.entries(refunds)) {
      const p = this.players.find(pl => pl.id === pid);
      if (p && amount > 0) {
        p.chips += amount;
        this.addLog(`${p.name} 退还未跟注的 ${amount}`);
      }
    }
    for (const [pid, amount] of Object.entries(payouts)) {
      const p = this.players.find(pl => pl.id === pid);
      if (p && amount > 0) p.chips += amount;
    }
  }

  buildWinners(payouts, playerHands) {
    const winners = [];
    for (const [pid, amount] of Object.entries(payouts)) {
      const p = this.players.find(pl => pl.id === pid);
      if (!p || amount <= 0) continue;
      const hand = this.wentToShowdown ? (playerHands[pid] || null) : null;
      winners.push({ player: p, amount, hand });
      this.addLog(`${p.name} 赢得 ${amount}${hand ? `（${hand.name}）` : ''}`);
    }
    return winners;
  }

  buildResult(pots, refunds, payouts, playerHands) {
    return {
      handCount: this.handCount,
      board: [...this.community],
      pots: pots.map(p => ({
        amount: p.amount,
        eligible: p.contributors.filter(x => !x.folded).map(x => x.id),
        refunded: p.contributors.length === 1 || p.contributors.every(x => x.folded)
      })),
      players: this.players.map(p => ({
        id: p.id,
        name: p.name,
        totalBet: p.totalBet,
        won: payouts[p.id] || 0,
        refunded: refunds[p.id] || 0,
        net: p.chips - (p.chipsAtHandStart || 0),
        handName: (this.wentToShowdown && !p.folded && playerHands[p.id])
          ? playerHands[p.id].name
          : null,
        // 最佳五张（PRD-04 §3.5）；只有真正摊牌且未弃牌才有
        bestCards: (this.wentToShowdown && !p.folded && playerHands[p.id] && playerHands[p.id].bestCards)
          ? playerHands[p.id].bestCards
          : null,
        shown: !!(this.wentToShowdown && !p.folded)
      }))
    };
  }

  // 结算并结束本局
  finishHand() {
    const { pots, refunds, payouts, playerHands } = this.settle();
    this.applyChips(refunds, payouts);
    this.winners = this.buildWinners(payouts, playerHands);
    this.result = this.buildResult(pots, refunds, payouts, playerHands);

    // 结算后断言（测试环境抛错，生产只记日志）
    const settled = Object.values(refunds).reduce((a, b) => a + b, 0)
      + Object.values(payouts).reduce((a, b) => a + b, 0);
    if (settled !== this.pot) {
      const msg = `结算金额不守恒：settled=${settled} pot=${this.pot}`;
      if (process.env.NODE_ENV === 'test') throw new Error(msg);
      this.addLog(msg);
    }

    this.pot = 0;
    this.stage = 'ended';
    this.turnDeadline = null;
    this.removeDisconnectedPlayers();
    this.advanceButton();
    this.bumpTurnSeq();
  }

  // 计算边池并分配
  showdown() {
    this.stage = 'showdown';
    const inHand = this.getPlayersInHand();

    // 只剩一人（或无人）：无需摊牌，底牌不公开
    if (inHand.length <= 1) {
      this.endHand();
      return;
    }

    this.wentToShowdown = true;
    this.finishHand();
  }

  endHand() {
    this.wentToShowdown = false;
    this.finishHand();
  }

  advanceButton() {
    const n = this.players.length;
    if (n === 0) return;
    let idx = this.buttonIndex;
    for (let i = 0; i < n; i++) {
      idx = (idx + 1) % n;
      if (this.players[idx].chips > 0) {
        this.buttonIndex = idx;
        return;
      }
    }
    this.buttonIndex = (this.buttonIndex + 1) % n;
  }

  // 返回给客户端的公共状态（隐藏他人底牌）
  getPublicState(selfId) {
    const self = this.players.find(p => p.id === selfId);
    const current = this.players[this.currentPlayerIndex];

    return {
      roomId: this.roomId,
      stage: this.stage,
      community: this.community,
      pot: this.pot,
      currentBet: this.currentBet,
      smallBlind: this.smallBlind,
      bigBlind: this.bigBlind,
      buttonIndex: this.buttonIndex,
      currentPlayerIndex: this.currentPlayerIndex,
      handCount: this.handCount,
      sbIndex: this.sbIndex,
      bbIndex: this.bbIndex,
      result: this.result,
      // 回合超时（PRD-02 §4.2）
      turnDeadline: this.isTurnActive() ? (this.turnDeadline || null) : null,
      turnTimeMs: this.turnTimeMs,
      winners: this.winners.map(w => ({
        name: w.player.name,
        amount: w.amount,
        handName: w.hand ? w.hand.name : null,
        hand: (w.hand && this.wentToShowdown) ? w.player.hand : null
      })),
      players: this.players.map((p, i) => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        folded: p.folded,
        allIn: p.allIn,
        currentBet: p.currentBet,
        totalBet: p.totalBet,
        hasActed: p.hasActed,
        disconnected: p.disconnected,
        ready: !!p.ready,
        isBot: !!p.isBot,
        isSelf: p.id === selfId,
        // 只有自己、或真正摊牌后的未弃牌者才可见底牌
        hand: (p.id === selfId || (this.wentToShowdown && !p.folded)) ? p.hand : [],
        index: i
      })),
      myTurn: current && current.id === selfId,
      minRaiseTo: this.currentBet + this.minRaise,
      callAmount: self ? Math.max(0, this.currentBet - self.currentBet) : 0,
      log: this.log.slice(-15)
    };
  }
}

module.exports = PokerGame;
