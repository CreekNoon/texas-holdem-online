const { Deck } = require('./deck');
const { evaluateBest, compareHands } = require('./handEvaluator');

const STAGES = ['preflop', 'flop', 'turn', 'river', 'showdown'];

class PokerGame {
  constructor(roomId, config = {}) {
    this.roomId = roomId;
    this.players = []; // {id, name, socket, chips, hand, folded, allIn, currentBet, totalBet, hasActed, isBot, disconnected}
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
    this.log = [];
    this.handCount = 0;
  }

  addPlayer(id, name, socket) {
    if (this.players.length >= 7) return null;
    const player = {
      id, name, socket,
      chips: this.startingChips,
      hand: [],
      folded: false,
      allIn: false,
      currentBet: 0,
      totalBet: 0,
      hasActed: false,
      isBot: false,
      disconnected: false
    };
    this.players.push(player);
    return player;
  }

  removePlayer(id) {
    const idx = this.players.findIndex(p => p.id === id);
    if (idx >= 0) {
      this.players.splice(idx, 1);
      // 调整 buttonIndex
      if (this.buttonIndex >= this.players.length && this.players.length > 0) {
        this.buttonIndex = this.buttonIndex % this.players.length;
      }
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
    this.stage = 'preflop';

    // 重置玩家状态（没筹码的玩家视为已坐下等待，不参与本局）
    for (const p of this.players) {
      p.hand = [];
      p.folded = p.chips <= 0;
      p.allIn = false;
      p.currentBet = 0;
      p.totalBet = 0;
      p.hasActed = false;
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
    const actual = Math.min(amount, player.chips);
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
    const player = this.players.find(p => p.id === playerId);
    if (!player || player.folded || player.allIn) return false;
    if (this.players[this.currentPlayerIndex].id !== playerId) return false;
    if (this.stage === 'showdown' || this.stage === 'ended' || this.stage === 'waiting') return false;

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
    // 只剩一人，直接结束牌局
    if (inHand.length === 1) {
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

    const stageIdx = STAGES.indexOf(this.stage);

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

    // 设置下一轮起始玩家：button 后第一位未弃牌玩家
    const n = this.players.length;
    let startIdx = (this.buttonIndex + 1) % n;
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
    }
  }

  // 计算边池并分配
  showdown() {
    this.stage = 'showdown';
    const inHand = this.getPlayersInHand();

    // 构建边池
    // 按 totalBet 排序
    const sorted = [...inHand].sort((a, b) => a.totalBet - b.totalBet);
    const pots = []; // { amount, contributors: [playerIds] }
    let prevBet = 0;
    for (const p of sorted) {
      if (p.totalBet > prevBet) {
        const diff = p.totalBet - prevBet;
        const contributors = this.players.filter(pl => pl.totalBet >= p.totalBet);
        pots.push({ amount: diff * contributors.length, contributors });
        prevBet = p.totalBet;
      }
    }

    // 如果只有一人在池中，直接赢得全部
    if (inHand.length === 1) {
      const winner = inHand[0];
      winner.chips += this.pot;
      this.winners = [{ player: winner, amount: this.pot, hand: null }];
      this.addLog(`${winner.name} 赢得底池 ${this.pot}`);
      this.pot = 0;
      this.stage = 'ended';
      this.advanceButton();
      return;
    }

    // 为每个边池找赢家
    const payouts = {}; // playerId -> amount
    const playerHands = {};
    for (const p of inHand) {
      playerHands[p.id] = evaluateBest([...p.hand, ...this.community]);
    }

    for (const pot of pots) {
      const eligible = pot.contributors.filter(p => !p.folded);
      if (eligible.length === 0) continue;
      let bestHand = null;
      let winners = [];
      for (const p of eligible) {
        const h = playerHands[p.id];
        if (!bestHand || compareHands(h, bestHand) > 0) {
          bestHand = h;
          winners = [p];
        } else if (compareHands(h, bestHand) === 0) {
          winners.push(p);
        }
      }
      const share = Math.floor(pot.amount / winners.length);
      const remainder = pot.amount - share * winners.length;
      for (let i = 0; i < winners.length; i++) {
        const w = winners[i];
        payouts[w.id] = (payouts[w.id] || 0) + share + (i < remainder ? 1 : 0);
      }
    }

    // 分配筹码
    this.winners = [];
    for (const [pid, amount] of Object.entries(payouts)) {
      const p = this.players.find(pl => pl.id === pid);
      if (p) {
        p.chips += amount;
        this.winners.push({ player: p, amount, hand: playerHands[pid] });
        this.addLog(`${p.name} 赢得 ${amount}（${playerHands[pid].name}）`);
      }
    }

    this.pot = 0;
    this.stage = 'ended';
    this.advanceButton();
  }

  endHand() {
    // 只剩一人，直接赢池
    const winner = this.getPlayersInHand()[0];
    if (winner) {
      winner.chips += this.pot;
      this.winners = [{ player: winner, amount: this.pot, hand: null }];
      this.addLog(`${winner.name} 赢得底池 ${this.pot}`);
    }
    this.pot = 0;
    this.stage = 'ended';
    this.advanceButton();
  }

  advanceButton() {
    const n = this.players.length;
    if (n > 0) {
      this.buttonIndex = (this.buttonIndex + 1) % n;
    }
  }

  // 返回给客户端的公共状态（隐藏他人底牌）
  getPublicState(selfId) {
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
      winners: this.winners.map(w => ({
        name: w.player.name,
        amount: w.amount,
        handName: w.hand ? w.hand.name : null,
        hand: w.hand ? w.player.hand : null
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
        isSelf: p.id === selfId,
        hand: (p.id === selfId || this.stage === 'showdown' || this.stage === 'ended') ? p.hand : [],
        index: i
      })),
      myTurn: this.players[this.currentPlayerIndex] && this.players[this.currentPlayerIndex].id === selfId,
      minRaiseTo: this.currentBet + this.minRaise,
      callAmount: this.players.find(p => p.id === selfId) ? Math.max(0, this.currentBet - (this.players.find(p => p.id === selfId).currentBet)) : 0,
      log: this.log.slice(-15)
    };
  }
}

module.exports = PokerGame;
