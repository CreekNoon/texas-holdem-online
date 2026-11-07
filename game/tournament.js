// SNG 单桌锦标赛状态机（PRD-05）
//
// 设计原则（§9）：Tournament 是外层控制器，只负责
//   报名 / 盲注升级 / 淘汰 / 名次 / 奖金，
// PokerGame 仍然只负责单手牌，不把锦标赛逻辑塞进牌局类。

const DEFAULT_BLIND_SCHEDULE = [
  { level: 1, sb: 10, bb: 20, ante: 0, durationMs: 5 * 60 * 1000 },
  { level: 2, sb: 15, bb: 30, ante: 0, durationMs: 5 * 60 * 1000 },
  { level: 3, sb: 25, bb: 50, ante: 5, durationMs: 5 * 60 * 1000 },
  { level: 4, sb: 50, bb: 100, ante: 10, durationMs: 5 * 60 * 1000 },
  { level: 5, sb: 75, bb: 150, ante: 15, durationMs: 5 * 60 * 1000 },
  { level: 6, sb: 100, bb: 200, ante: 20, durationMs: 5 * 60 * 1000 },
  { level: 7, sb: 150, bb: 300, ante: 30, durationMs: 5 * 60 * 1000 },
  { level: 8, sb: 250, bb: 500, ante: 50, durationMs: 5 * 60 * 1000 }
];

const STATE = {
  REGISTERING: 'registering',
  RUNNING: 'running',
  FINISHED: 'finished'
};

// 奖金结构：3 人以上 50/30/20，2 人 65/35
function defaultPayoutStructure(playerCount) {
  if (playerCount >= 3) {
    return [
      { place: 1, percent: 50 },
      { place: 2, percent: 30 },
      { place: 3, percent: 20 }
    ];
  }
  return [
    { place: 1, percent: 65 },
    { place: 2, percent: 35 }
  ];
}

// 按比例分配，向下取整，余数给冠军（PRD-05 §3.2）
function computePayouts(prizePool, structure) {
  const payouts = {};
  let distributed = 0;

  for (const { place, percent } of structure) {
    const amount = Math.floor(prizePool * percent / 100);
    payouts[place] = amount;
    distributed += amount;
  }

  // 余数给冠军
  const remainder = prizePool - distributed;
  if (remainder > 0) {
    payouts[1] = (payouts[1] || 0) + remainder;
  }
  return payouts;
}

class Tournament {
  constructor(options = {}) {
    this.id = options.id || 'sng';
    this.name = options.name || 'SNG 单桌赛';
    this.state = STATE.REGISTERING;

    this.buyIn = Number.isSafeInteger(options.buyIn) && options.buyIn > 0
      ? options.buyIn : 100;
    this.startingChips = Number.isSafeInteger(options.startingChips) && options.startingChips > 0
      ? options.startingChips : 1000;
    this.maxPlayers = Math.min(options.maxPlayers || 7, 7);

    // 深拷贝，避免外部修改
    this.blindSchedule = (options.blindSchedule || DEFAULT_BLIND_SCHEDULE)
      .map(x => ({ ...x }));

    // 可注入的等级时长（测试用）：覆盖 schedule 里的 durationMs
    if (Number.isSafeInteger(options.levelDurationMs) && options.levelDurationMs > 0) {
      for (const lv of this.blindSchedule) lv.durationMs = options.levelDurationMs;
    }

    this.entrants = []; // { playerId, name, place: null, payout: 0, eliminated: false }
    this.prizePool = 0;
    this.payoutStructure = [];

    this.levelIndex = 0;
    this.levelEndsAt = null;
    this.pendingLevel = false;
    this.startedAt = null;
    this.finishedAt = null;

    this.handCount = 0;
    this.eliminationOrder = []; // 按淘汰先后记录 playerId
  }

  // ===== 报名（§4.1）=====

  canRegister(playerId) {
    if (this.state !== STATE.REGISTERING) return false;
    if (this.entrants.length >= this.maxPlayers) return false;
    if (this.entrants.some(e => e.playerId === playerId)) return false;
    return true;
  }

  register(playerId, name) {
    if (!this.canRegister(playerId)) return null;
    const entrant = {
      playerId,
      name,
      place: null,
      payout: 0,
      eliminated: false,
      chipsAtHandStart: 0
    };
    this.entrants.push(entrant);
    return entrant;
  }

  // 报名阶段退出：退还买入（本期买入为虚拟记分，不涉及真实余额）
  unregister(playerId) {
    if (this.state !== STATE.REGISTERING) return false;
    const idx = this.entrants.findIndex(e => e.playerId === playerId);
    if (idx < 0) return false;
    this.entrants.splice(idx, 1);
    return true;
  }

  get entrantCount() {
    return this.entrants.length;
  }

  // ===== 开始（§4.1）=====

  start(now = Date.now()) {
    if (this.state !== STATE.REGISTERING) return false;
    if (this.entrants.length < 2) return false;

    this.state = STATE.RUNNING;
    this.prizePool = this.buyIn * this.entrants.length;
    this.payoutStructure = defaultPayoutStructure(this.entrants.length);
    this.startedAt = now;
    this.levelIndex = 0;
    this.levelEndsAt = now + this.blindSchedule[0].durationMs;
    this.pendingLevel = false;
    this.handCount = 0;
    this.eliminationOrder = [];
    return true;
  }

  // ===== 盲注（§4.2）=====

  get currentLevel() {
    return this.blindSchedule[Math.min(this.levelIndex, this.blindSchedule.length - 1)];
  }

  get nextLevel() {
    const idx = this.levelIndex + 1;
    return idx < this.blindSchedule.length ? this.blindSchedule[idx] : null;
  }

  get blinds() {
    const lv = this.currentLevel;
    return { sb: lv.sb, bb: lv.bb, ante: lv.ante };
  }

  // 时间到：若正进行一手则标记 pendingLevel，否则立即升级
  tickLevel(now = Date.now(), handInProgress = false) {
    if (this.state !== STATE.RUNNING) return null;
    if (this.levelEndsAt === null || now < this.levelEndsAt) return null;
    if (this.levelIndex >= this.blindSchedule.length - 1) {
      // 已到最后一档：保持，不再升级
      this.levelEndsAt = null;
      return null;
    }

    if (handInProgress) {
      this.pendingLevel = true;
      this.levelEndsAt = null;
      return { pending: true };
    }

    return this.applyPendingLevel(now);
  }

  // 本手结束后应用挂起的升级（§4.2 升级顺序必须确定）
  applyPendingLevel(now = Date.now()) {
    if (this.state !== STATE.RUNNING) return null;
    if (this.levelIndex >= this.blindSchedule.length - 1) return null;

    this.levelIndex++;
    this.pendingLevel = false;
    const lv = this.currentLevel;
    this.levelEndsAt = now + lv.durationMs;
    return { level: lv.level, sb: lv.sb, bb: lv.bb, ante: lv.ante, levelEndsAt: this.levelEndsAt };
  }

  // 每手结束时调用：先应用挂起升级，再开始下一手（保证下一手用新盲注）
  onHandFinished(now = Date.now()) {
    if (this.state !== STATE.RUNNING) return null;
    this.handCount++;

    // 先淘汰，再升级（升级与淘汰互不影响，但顺序要确定）
    const eliminated = this.eliminateBusted();
    const levelChange = this.pendingLevel ? this.applyPendingLevel(now) : null;

    // 只剩 1 人 → 结束
    const alive = this.aliveEntrants();
    if (alive.length <= 1) {
      this.finish(now);
    }

    return { eliminated, levelChange, finished: this.state === STATE.FINISHED };
  }

  // ===== 淘汰与名次（§4.4）=====

  aliveEntrants() {
    return this.entrants.filter(e => !e.eliminated);
  }

  // players: [{ id, name, chips, chipsAtHandStart }]，来自 PokerGame
  // 淘汰判定依赖外部传入的本手开始前筹码（不能用手结束时的 0）
  eliminateBusted() {
    const busted = this.entrants.filter(e => !e.eliminated && e.chips === 0);
    if (busted.length === 0) return [];

    // 同时淘汰：按本手开始前筹码降序，再按 entrants 原始顺序（座位顺序）
    const sorted = busted.slice().sort((a, b) => {
      const diff = (b.chipsAtHandStart || 0) - (a.chipsAtHandStart || 0);
      if (diff !== 0) return diff;
      return this.entrants.indexOf(a) - this.entrants.indexOf(b);
    });

    const aliveBefore = this.entrants.filter(e => !e.eliminated).length;
    // 名次区间：从 (aliveBefore - busted.length + 1) 开始递增
    // 例：6 人局 3 人同时出局 → 名次 4、5、6（筹码多者得 4）
    const firstPlace = aliveBefore - sorted.length + 1;
    const result = [];

    sorted.forEach((e, i) => {
      e.eliminated = true;
      e.place = firstPlace + i;
      this.eliminationOrder.push(e.playerId);
      result.push({ playerId: e.playerId, name: e.name, place: e.place });
    });

    return result;
  }

  // 由 PokerGame 的玩家状态同步筹码，并记录本手开始前筹码
  syncChips(players) {
    for (const e of this.entrants) {
      const p = players.find(x => x.id === e.playerId);
      if (!p) continue;
      e.chips = p.chips;
      // chipsAtHandStart 由 beginHand 写入
    }
  }

  beginHand(players) {
    for (const e of this.entrants) {
      const p = players.find(x => x.id === e.playerId);
      if (!p) continue;
      e.chipsAtHandStart = p.chips;
      e.chips = p.chips;
    }
  }

  finish(now = Date.now()) {
    if (this.state === STATE.FINISHED) return false;

    const alive = this.aliveEntrants();

    if (alive.length === 1) {
      const champ = alive[0];
      champ.place = 1;
      champ.eliminated = false;
      if (!this.eliminationOrder.includes(champ.playerId)) {
        this.eliminationOrder.push(champ.playerId);
      }
    } else if (alive.length > 1) {
      // 异常情况：多人存活但已结束，按筹码降序排
      alive.sort((a, b) => (b.chips || 0) - (a.chips || 0));
      alive.forEach((e, i) => {
        e.place = i + 1;
        e.eliminated = false;
      });
    } else {
      // 极端情况：最后两人在同一手同时出局（例如双方 all-in 且筹码相同）。
      // 必须产生一个冠军，否则名次缺失。按本手开始前筹码降序 → 座位顺序取第一人。
      const all = this.entrants.slice().sort((a, b) => {
        const diff = (b.chipsAtHandStart || 0) - (a.chipsAtHandStart || 0);
        if (diff !== 0) return diff;
        return this.entrants.indexOf(a) - this.entrants.indexOf(b);
      });

      all.forEach((e, i) => {
        e.place = i + 1;
        // 只有冠军恢复为"未淘汰"，其余保持淘汰
        e.eliminated = i !== 0;
      });

      // 重建淘汰顺序：冠军最后（存活到最后）
      const champ = all[0];
      this.eliminationOrder = all.slice(1).map(e => e.playerId);
      this.eliminationOrder.push(champ.playerId);
    }

    // 发奖金
    const payouts = computePayouts(this.prizePool, this.payoutStructure);
    for (const e of this.entrants) {
      e.payout = payouts[e.place] || 0;
    }

    this.state = STATE.FINISHED;
    this.finishedAt = now;
    this.levelEndsAt = null;
    this.pendingLevel = false;
    return true;
  }

  // 名次表（按名次升序）
  standings() {
    return this.entrants
      .slice()
      .sort((a, b) => (a.place || 999) - (b.place || 999))
      .map(e => ({
        playerId: e.playerId,
        name: e.name,
        place: e.place,
        payout: e.payout,
        eliminated: e.eliminated,
        chips: e.chips || 0
      }));
  }

  // 下发给客户端的快照（§5.1）
  toPublicState() {
    const lv = this.currentLevel;
    const next = this.nextLevel;
    return {
      state: this.state,
      buyIn: this.buyIn,
      startingChips: this.startingChips,
      maxPlayers: this.maxPlayers,
      prizePool: this.prizePool,
      level: lv.level,
      sb: lv.sb,
      bb: lv.bb,
      ante: lv.ante,
      levelEndsAt: this.levelEndsAt,
      pendingLevel: this.pendingLevel,
      nextLevel: next ? { sb: next.sb, bb: next.bb, ante: next.ante } : null,
      entrants: this.standings(),
      payoutStructure: this.payoutStructure,
      playerCount: this.entrants.length,
      aliveCount: this.aliveEntrants().length,
      handCount: this.handCount,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt
    };
  }
}

module.exports = {
  Tournament,
  STATE,
  DEFAULT_BLIND_SCHEDULE,
  defaultPayoutStructure,
  computePayouts
};
