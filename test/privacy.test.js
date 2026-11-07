const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

const c = (suit, rank) => ({ suit, rank });

function setupShowdown() {
  const game = new PokerGame('test');
  for (const id of ['A', 'B', 'C']) game.addPlayer(id, id, null);
  game.stage = 'river';
  game.community = [
    c('spades', '2'), c('hearts', '7'), c('clubs', 'J'),
    c('diamonds', '4'), c('spades', '9')
  ];
  game.players[0].hand = [c('hearts', 'A'), c('hearts', 'K')];
  game.players[0].totalBet = 100;
  game.players[0].chips = 900;

  game.players[1].hand = [c('clubs', '3'), c('clubs', '5')];
  game.players[1].totalBet = 100;
  game.players[1].chips = 900;
  game.players[1].folded = true;

  game.players[2].hand = [c('diamonds', 'A'), c('diamonds', 'Q')];
  game.players[2].totalBet = 100;
  game.players[2].chips = 900;

  game.pot = 300;
  return game;
}

test('3.6 弃牌玩家底牌对他人不可见', () => {
  const game = setupShowdown();
  game.showdown();

  const stateForC = game.getPublicState('p_C');
  const b = stateForC.players.find(p => p.id === 'B');
  assert.deepStrictEqual(b.hand, [], '弃牌者底牌必须为空');
});

test('3.6 摊牌时未弃牌输家底牌可见', () => {
  const game = setupShowdown();
  game.showdown();

  const stateForC = game.getPublicState('p_C');
  const a = stateForC.players.find(p => p.id === 'A');
  assert.strictEqual(a.hand.length, 2, '未弃牌输家底牌应可见');
});

test('3.6 自己始终能看到自己的底牌', () => {
  const game = setupShowdown();
  game.showdown();

  const stateForA = game.getPublicState('p_A');
  const a = stateForA.players.find(p => p.id === 'A');
  assert.strictEqual(a.hand.length, 2);
});

test('3.6 弃牌退款玩家底牌仍不可见', () => {
  const game = new PokerGame('test');
  for (const id of ['A', 'B']) game.addPlayer(id, id, null);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.players[1].chips = 100;
  game.startHand();

  game.playerAction('A', 'raise', 300);
  game.playerAction('B', 'allin');
  game.playerAction('A', 'fold');

  // A 弃牌且拿到 200 退款
  const a = game.players.find(p => p.id === 'A');
  assert.strictEqual(a.chips, 900, 'A 应拿到退款');

  const state = game.getPublicState('p_B');
  const aState = state.players.find(p => p.id === 'A');
  assert.deepStrictEqual(aState.hand, [], '退款玩家的底牌不可见');
});

test('3.6 endHand（全员弃牌）不公开赢家底牌', () => {
  const game = new PokerGame('test');
  for (const id of ['A', 'B']) game.addPlayer(id, id, null);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  game.playerAction('A', 'fold');

  assert.strictEqual(game.stage, 'ended');
  assert.strictEqual(game.wentToShowdown, false);

  const state = game.getPublicState('p_A');
  const b = state.players.find(p => p.id === 'B');
  assert.deepStrictEqual(b.hand, [], '全员弃牌时赢家底牌不公开');
  // winners 里的 hand 也必须为空
  assert.ok(state.winners.every(w => w.hand === null));
});

test('3.6 showdown 阶段不会在广播中出现（stage 直接变 ended）', () => {
  const game = setupShowdown();
  game.showdown();
  assert.strictEqual(game.stage, 'ended');
  assert.strictEqual(game.wentToShowdown, true);
});

test('3.6 摊牌可见性对房间内所有查看者一致（观战角色过滤属 PRD-04）', () => {
  const game = setupShowdown();
  game.showdown();
  // 摊牌后未弃牌者底牌对全桌公开（真实扑克行为）；
  // 观战者的额外过滤（默认只看公共牌）由 PRD-04 实现，不在本 PRD 范围
  const state = game.getPublicState('someone-else');
  const a = state.players.find(p => p.id === 'A');
  const b = state.players.find(p => p.id === 'B');
  assert.strictEqual(a.hand.length, 2, '摊牌后未弃牌者底牌公开');
  assert.deepStrictEqual(b.hand, [], '弃牌者底牌始终不公开');
});
