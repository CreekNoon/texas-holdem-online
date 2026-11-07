const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');
const { evaluateBest, compareHands } = require('../game/handEvaluator');

const c = (suit, rank) => ({ suit, rank });

// ===== bestCards（PRD-04 §3.5）=====

test('3.5 evaluateBest withCards 返回最佳五张', () => {
  const cards = [
    c('spades', 'A'), c('hearts', 'A'),
    c('diamonds', 'K'), c('clubs', 'K'),
    c('spades', 'K'), c('hearts', '3'), c('clubs', '2')
  ];
  const result = evaluateBest(cards, { withCards: true });
  assert.ok(result.bestCards, 'bestCards 必须存在');
  assert.strictEqual(result.bestCards.length, 5);
  // 牌型一致
  const fast = evaluateBest(cards);
  assert.strictEqual(result.rank, fast.rank);
  assert.deepStrictEqual(result.tiebreakers, fast.tiebreakers);
});

test('3.5 bestCards 的 5 张牌全部来自输入的 7 张', () => {
  for (let i = 0; i < 200; i++) {
    const game = new PokerGame('t', { startingChips: 1000 });
    game.addPlayer('A', 'A', null);
    game.addPlayer('B', 'B', null);
    game.stage = 'ended';
    if (!game.startHand()) continue;

    // 用发牌器真实发出的公共牌，避免与底牌重复
    game.stage = 'river';
    game.deck.burn();
    game.community = [
      game.deck.deal(), game.deck.deal(), game.deck.deal(),
      game.deck.deal(), game.deck.deal()
    ];

    const p = game.players[0];
    const all = [...p.hand, ...game.community];
    const result = evaluateBest(all, { withCards: true });

    const inputKeys = new Set(all.map(x => `${x.suit}:${x.rank}`));
    for (const card of result.bestCards) {
      assert.ok(inputKeys.has(`${card.suit}:${card.rank}`), 'bestCards 必须来自输入牌');
    }
    const keys = result.bestCards.map(x => `${x.suit}:${x.rank}`);
    assert.strictEqual(new Set(keys).size, 5, 'bestCards 不应有重复牌');
  }
});

test('3.5 不足 5 张时 bestCards 为 null（evaluateBest 返回 null）', () => {
  assert.strictEqual(evaluateBest([], { withCards: true }), null);
  assert.strictEqual(evaluateBest([c('hearts', '2'), c('hearts', '7')], { withCards: true }), null);
});

test('3.5 result 中包含 bestCards', () => {
  const game = new PokerGame('t');
  game.addPlayer('A', 'A', null);
  game.addPlayer('B', 'B', null);
  game.stage = 'river';
  game.community = [
    c('spades', '2'), c('hearts', '7'), c('clubs', 'J'),
    c('diamonds', '4'), c('spades', '9')
  ];
  game.players[0].hand = [c('hearts', 'A'), c('hearts', 'K')];
  game.players[1].hand = [c('clubs', '3'), c('clubs', '5')];
  game.players.forEach(p => { p.totalBet = 100; p.chips = 900; });
  game.pot = 200;

  game.showdown();

  const a = game.result.players.find(p => p.id === 'A');
  assert.ok(Array.isArray(a.bestCards), '摊牌玩家应有 bestCards');
  assert.strictEqual(a.bestCards.length, 5);
});

test('3.5 弃牌者与 endHand 不返回 bestCards', () => {
  // 弃牌者
  const game = new PokerGame('t');
  game.addPlayer('A', 'A', null);
  game.addPlayer('B', 'B', null);
  game.addPlayer('C', 'C', null);
  game.stage = 'river';
  game.community = [
    c('spades', '2'), c('hearts', '7'), c('clubs', 'J'),
    c('diamonds', '4'), c('spades', '9')
  ];
  game.players[0].hand = [c('hearts', 'A'), c('hearts', 'K')];
  game.players[1].hand = [c('clubs', '3'), c('clubs', '5')];
  game.players[1].folded = true;
  game.players[2].hand = [c('diamonds', 'A'), c('diamonds', 'Q')];
  game.players.forEach(p => { p.totalBet = 100; p.chips = 900; });
  game.pot = 300;
  game.showdown();

  const b = game.result.players.find(p => p.id === 'B');
  assert.strictEqual(b.bestCards, null, '弃牌者不应有 bestCards');

  // endHand（全员弃牌）
  const g2 = new PokerGame('t');
  g2.addPlayer('A', 'A', null);
  g2.addPlayer('B', 'B', null);
  g2.stage = 'ended';
  g2.startHand();
  g2.playerAction('A', 'fold', 0);
  assert.ok(g2.result.players.every(p => p.bestCards === null), 'endHand 不应有 bestCards');
});

test('3.5 bestCards 与 fast 路径牌型一致（1000 手）', () => {
  for (let i = 0; i < 1000; i++) {
    const game = new PokerGame('t');
    game.addPlayer('A', 'A', null);
    game.addPlayer('B', 'B', null);
    game.stage = 'ended';
    game.startHand();
    game.stage = 'river';
    game.deck.burn();
    game.community = [
      game.deck.deal(), game.deck.deal(), game.deck.deal(),
      game.deck.deal(), game.deck.deal()
    ];
    const all = [...game.players[0].hand, ...game.community];
    const withCards = evaluateBest(all, { withCards: true });
    const fast = evaluateBest(all);
    assert.strictEqual(compareHands(withCards, fast), 0);
  }
});

// ===== 准备状态 =====

test('3.2 新玩家默认未准备，机器人默认已准备', () => {
  const game = new PokerGame('t');
  const human = game.addPlayer('p1', 'Human', null);
  assert.strictEqual(human.ready, false);

  const bot = game.addBot('Bot', {});
  assert.strictEqual(bot.ready, true);
});

test('3.2 ready 状态随 getPublicState 下发', () => {
  const game = new PokerGame('t');
  game.addPlayer('p1', 'A', null);
  game.addPlayer('p2', 'B', null);
  game.players[0].ready = true;

  const state = game.getPublicState('p1');
  assert.strictEqual(state.players[0].ready, true);
  assert.strictEqual(state.players[1].ready, false);
});
