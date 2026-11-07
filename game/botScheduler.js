// 机器人调度（PRD-03 §4.1）
//
// 职责：在轮到 bot 时延迟 600–1400ms 调用 game.playerAction。
// 只依赖公共状态 + 该 bot 自己的底牌，绝不读取他人底牌。

const { BotBrain } = require('./bot');

class BotScheduler {
  constructor(game, options = {}) {
    this.game = game;
    this.minDelay = options.minDelay || 600;
    this.maxDelay = options.maxDelay || 1400;
    this.onAction = options.onAction || (() => {});
    this.timer = null;
    this.brains = new Map(); // botId -> BotBrain
    this.lastSeq = -1;
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  brainFor(player) {
    if (!this.brains.has(player.id)) {
      this.brains.set(player.id, new BotBrain({
        difficulty: player.botDifficulty || 'normal',
        name: player.name
      }));
    }
    return this.brains.get(player.id);
  }

  // 每次状态变化后调用；内部用 turnSeq 去重，避免重复调度同一回合
  tick() {
    if (this.stopped) return;
    const game = this.game;

    if (!game.isActionPhase || !game.isActionPhase()) return;

    const cur = game.players[game.currentPlayerIndex];
    if (!cur || !cur.isBot) return;
    if (this.lastSeq === game.turnSeq) return;

    this.lastSeq = game.turnSeq;

    if (this.timer) clearTimeout(this.timer);
    const delay = this.minDelay + Math.floor(Math.random() * (this.maxDelay - this.minDelay));

    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.stopped) return;
      this.act(cur.id);
    }, delay);

    if (this.timer.unref) this.timer.unref();
  }

  act(botId) {
    const game = this.game;
    const cur = game.players[game.currentPlayerIndex];
    // 延迟期间状态可能已变
    if (!cur || cur.id !== botId || !cur.isBot) return;
    if (!game.isActionPhase || !game.isActionPhase()) return;

    const self = this.buildSelfView(cur);
    const state = this.buildPublicView(botId);

    let decision;
    try {
      decision = this.brainFor(cur).decide({ state, self });
    } catch (err) {
      decision = { action: state.callAmount === 0 ? 'check' : 'fold' };
    }

    const ok = game.playerAction(botId, decision.action, decision.amount || 0);
    if (!ok) {
      // 降级：最小合法动作
      const fallback = Math.max(0, game.currentBet - cur.currentBet) === 0 ? 'check' : 'fold';
      game.playerAction(botId, fallback, 0);
    }

    this.onAction(botId, decision);
  }

  // 只给该 bot 自己的底牌
  buildSelfView(bot) {
    return {
      id: bot.id,
      name: bot.name,
      chips: bot.chips,
      currentBet: bot.currentBet,
      totalBet: bot.totalBet,
      folded: bot.folded,
      allIn: bot.allIn,
      hand: bot.hand.slice()
    };
  }

  // 公共信息：不含任何他人底牌
  buildPublicView(selfId) {
    const game = this.game;
    const self = game.players.find(p => p.id === selfId);
    return {
      stage: game.stage,
      community: game.community.slice(),
      pot: game.pot,
      currentBet: game.currentBet,
      minRaiseTo: game.currentBet + game.minRaise,
      smallBlind: game.smallBlind,
      bigBlind: game.bigBlind,
      callAmount: self ? Math.max(0, game.currentBet - self.currentBet) : 0,
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        chips: p.chips,
        folded: p.folded,
        allIn: p.allIn,
        currentBet: p.currentBet,
        totalBet: p.totalBet,
        isBot: !!p.isBot
        // 注意：不包含 hand
      }))
    };
  }
}

module.exports = { BotScheduler };
