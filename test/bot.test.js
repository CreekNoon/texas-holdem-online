const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');
const { BotBrain } = require('../game/bot');
const { BotScheduler } = require('../game/botScheduler');

const c = (suit, rank) => ({ suit, rank });

function makeGame(botCount = 3) {
  const game = new PokerGame('bot-test');
  game.addPlayer('p_human', 'Human', { id: 'sock-human' });
  game.fillWithBots(botCount + 1, 'normal');
  return game;
}

// ===== 机器人不可读取他人底牌（PRD-03 §4.1 / 验收）=====

test('4.1 BotScheduler 的公共视图不含任何他人底牌', () => {
  const game = makeGame(2);
  game.stage = 'ended';
  game.startHand();

  const sched = new BotScheduler(game, { minDelay: 1, maxDelay: 2 });
  const bot = game.players.find(p => p.isBot);

  const view = sched.buildPublicView(bot.id);
  for (const p of view.players) {
    assert.strictEqual(p.hand, undefined, `${p.name} 的底牌不应出现在公共视图`);
  }
  assert.strictEqual(view.players.length, game.players.length);

  sched.stop();
});

test('4.1 BotScheduler 的自视图只含自己的底牌', () => {
  const game = makeGame(2);
  game.stage = 'ended';
  game.startHand();

  const sched = new BotScheduler(game, { minDelay: 1, maxDelay: 2 });
  const bot = game.players.find(p => p.isBot);
  const self = sched.buildSelfView(bot);

  assert.strictEqual(self.hand.length, 2);
  assert.deepStrictEqual(self.hand, bot.hand);
  assert.strictEqual(self.id, bot.id);

  sched.stop();
});

// ===== 决策合法性 =====

test('4.1 机器人决策全部合法（1 万次）', () => {
  const game = makeGame(3);
  const brain = new BotBrain({ difficulty: 'normal' });
  const sched = new BotScheduler(game, { minDelay: 1, maxDelay: 2 });

  let checked = 0;
  for (let i = 0; i < 10000; i++) {
    game.stage = 'ended';
    game.startHand();

    // 强制轮到某个机器人，保证每次都能取到 bot 视角
    const botIndex = game.players.findIndex(p => p.isBot);
    game.currentPlayerIndex = botIndex;
    const bot = game.players[botIndex];

    const self = sched.buildSelfView(bot);
    const state = sched.buildPublicView(bot.id);

    const decision = brain.decide({ state, self });
    checked++;

    assert.ok(['fold', 'check', 'call', 'raise', 'allin'].includes(decision.action),
      `非法 action: ${decision.action}`);
    if (decision.action === 'raise') {
      assert.ok(Number.isSafeInteger(decision.amount), `raise amount 必须是整数: ${decision.amount}`);
      assert.ok(decision.amount > 0, 'raise amount 必须 > 0');
    }
  }
  sched.stop();
  assert.strictEqual(checked, 10000);
});

test('4.1 机器人动作走 playerAction 校验路径且不产生 NaN', () => {
  const game = makeGame(3);
  game.stage = 'ended';
  game.startHand();

  const sched = new BotScheduler(game, { minDelay: 1, maxDelay: 2 });
  let acted = 0;

  for (let i = 0; i < 500 && game.stage !== 'ended'; i++) {
    const cur = game.players[game.currentPlayerIndex];
    if (!cur) break;

    if (cur.isBot) {
      const self = sched.buildSelfView(cur);
      const state = sched.buildPublicView(cur.id);
      const decision = new BotBrain({ difficulty: 'normal' }).decide({ state, self });
      const ok = game.playerAction(cur.id, decision.action, decision.amount || 0);
      if (!ok) {
        // 降级必须也是合法动作
        const call = Math.max(0, game.currentBet - cur.currentBet);
        game.playerAction(cur.id, call === 0 ? 'check' : 'fold', 0);
      }
      acted++;
    } else {
      const call = Math.max(0, game.currentBet - cur.currentBet);
      game.playerAction(cur.id, call === 0 ? 'check' : 'call', 0);
    }

    for (const p of game.players) {
      assert.ok(Number.isSafeInteger(p.chips), `${p.name} chips 非整数: ${p.chips}`);
    }
    assert.ok(Number.isSafeInteger(game.pot), `pot 非整数: ${game.pot}`);
  }

  assert.ok(acted > 0, '机器人应至少行动一次');
  sched.stop();
});

// ===== 调度 =====

test('4.1 调度器只在 bot 回合触发', async () => {
  const game = makeGame(2);
  game.stage = 'ended';
  game.startHand();

  // 强制轮到人类
  game.currentPlayerIndex = game.players.findIndex(p => !p.isBot);
  const sched = new BotScheduler(game, { minDelay: 5, maxDelay: 10 });
  let fired = false;
  sched.onAction = () => { fired = true; };
  sched.tick();
  await new Promise(r => setTimeout(r, 60));
  assert.strictEqual(fired, false, '人类回合不应触发机器人');
  sched.stop();
});

test('4.1 调度器在同一回合只调度一次', async () => {
  const game = makeGame(2);
  game.stage = 'ended';
  game.startHand();

  const sched = new BotScheduler(game, { minDelay: 20, maxDelay: 30 });
  let count = 0;
  sched.onAction = () => { count++; };

  sched.tick();
  sched.tick();
  sched.tick();
  await new Promise(r => setTimeout(r, 80));

  assert.ok(count <= 1, `同一回合不应重复调度，实际触发 ${count} 次`);
  sched.stop();
});

test('4.1 stop() 后不再触发', async () => {
  const game = makeGame(2);
  game.stage = 'ended';
  game.startHand();

  const sched = new BotScheduler(game, { minDelay: 30, maxDelay: 40 });
  let fired = false;
  sched.onAction = () => { fired = true; };
  sched.tick();
  sched.stop();
  await new Promise(r => setTimeout(r, 80));
  assert.strictEqual(fired, false, 'stop 后不应再触发');
});

// ===== 补位与训练模式 =====

test('4.3 fillWithBots 补足到目标人数', () => {
  const game = new PokerGame('t');
  game.addPlayer('p1', 'Human', { id: 's1' });
  const added = game.fillWithBots(4, 'normal');
  assert.strictEqual(added.length, 3);
  assert.strictEqual(game.players.length, 4);
  assert.strictEqual(game.players.filter(p => p.isBot).length, 3);
});

test('4.3 fillWithBots 不超过 7 人上限', () => {
  const game = new PokerGame('t');
  game.addPlayer('p1', 'Human', { id: 's1' });
  game.fillWithBots(20, 'normal');
  assert.ok(game.players.length <= 7);
});

test('4.3 机器人不占真人上限但总座位 ≤ 7', () => {
  const game = new PokerGame('t');
  for (let i = 0; i < 5; i++) game.addPlayer('p' + i, 'Human' + i, { id: 's' + i });
  game.fillWithBots(7, 'normal');
  assert.strictEqual(game.players.length, 7);
});

test('4.3 牌局中不能补机器人', () => {
  const game = makeGame(2);
  game.stage = 'ended';
  game.startHand();
  assert.strictEqual(game.addBot('late', {}), null);
});

test('4.3 三档难度都能产出合法决策', () => {
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const game = makeGame(3);
    game.stage = 'ended';
    game.startHand();

    const bot = game.players[game.currentPlayerIndex];
    if (!bot.isBot) continue;

    const sched = new BotScheduler(game, { minDelay: 1, maxDelay: 2 });
    const brain = new BotBrain({ difficulty });
    const decision = brain.decide({
      state: sched.buildPublicView(bot.id),
      self: sched.buildSelfView(bot)
    });

    assert.ok(['fold', 'check', 'call', 'raise', 'allin'].includes(decision.action),
      `${difficulty} 难度产出非法动作`);
    sched.stop();
  }
});

test('4.3 resetChips 恢复所有玩家筹码', () => {
  const game = makeGame(2);
  game.players[0].chips = 0;
  game.players[1].chips = 50;
  game.resetChips(1000);
  assert.ok(game.players.every(p => p.chips === 1000));
  assert.strictEqual(game.withdrawnChips, 0);
});

// ===== 完整对局 =====

test('4.3 单人 + 3 机器人能打完 20 局且筹码守恒', () => {
  const game = new PokerGame('t');
  game.addPlayer('p_human', 'Human', { id: 's1' });
  game.fillWithBots(4, 'normal');
  const initial = game.players.reduce((a, p) => a + p.chips, 0);

  const sched = new BotScheduler(game, { minDelay: 1, maxDelay: 2 });

  for (let hand = 0; hand < 20; hand++) {
    game.stage = 'ended';
    if (!game.startHand()) break;

    let guard = 0;
    while (game.stage !== 'ended' && guard++ < 500) {
      const cur = game.players[game.currentPlayerIndex];
      if (!cur) break;

      if (cur.isBot) {
        const decision = new BotBrain({ difficulty: 'normal' }).decide({
          state: sched.buildPublicView(cur.id),
          self: sched.buildSelfView(cur)
        });
        if (!game.playerAction(cur.id, decision.action, decision.amount || 0)) {
          const call = Math.max(0, game.currentBet - cur.currentBet);
          game.playerAction(cur.id, call === 0 ? 'check' : 'fold', 0);
        }
      } else {
        const call = Math.max(0, game.currentBet - cur.currentBet);
        game.playerAction(cur.id, call === 0 ? 'check' : 'call', 0);
      }
    }
    assert.strictEqual(game.stage, 'ended', `第 ${hand + 1} 局未结束（卡死）`);
  }

  sched.stop();
  const final = game.players.reduce((a, p) => a + p.chips, 0) + game.withdrawnChips;
  assert.strictEqual(final, initial, `20 局后筹码不守恒: ${final} != ${initial}`);
});
