const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

const c = (suit, rank) => ({ suit, rank });

function playOut(game, maxSteps = 200) {
  let steps = 0;
  while (['preflop', 'flop', 'turn', 'river'].includes(game.stage) && steps++ < maxSteps) {
    const cur = game.players[game.currentPlayerIndex];
    if (!cur) break;
    const call = Math.max(0, game.currentBet - cur.currentBet);
    if (!game.playerAction(cur.id, call === 0 ? 'check' : 'call', 0)) {
      game.playerAction(cur.id, 'fold', 0);
    }
  }
}

test('3.7 showdown 产出完整 result', () => {
  const game = new PokerGame('test');
  for (const id of ['A', 'B']) game.addPlayer(id, id, null);
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

  const result = game.result;
  assert.ok(result, 'result 必须存在');
  assert.strictEqual(result.handCount, game.handCount);
  assert.strictEqual(result.board.length, 5);
  assert.ok(result.pots.length > 0);
  assert.strictEqual(result.players.length, 2);
});

test('3.7 result 边池金额之和等于结算前底池', () => {
  for (let i = 0; i < 100; i++) {
    const game = new PokerGame('test', { startingChips: [100, 500, 1000][i % 3] });
    const n = 2 + (i % 6);
    for (let j = 0; j < n; j++) game.addPlayer(`P${j}`, `P${j}`, null);
    game.stage = 'ended';
    game.buttonIndex = i % n;
    if (!game.startHand()) continue;

    playOut(game);
    if (!game.result) continue;

    // 结算后 totalBet 不清零，Σ totalBet 就是结算前的底池
    const totalBet = game.players.reduce((a, p) => a + p.totalBet, 0);
    const potSum = game.result.pots.reduce((a, p) => a + p.amount, 0);
    assert.strictEqual(potSum, totalBet, `第 ${i} 局边池金额之和应等于结算前底池`);
  }
});

test('3.7 result 中弃牌者 shown=false 且无牌型', () => {
  const game = new PokerGame('test');
  for (const id of ['A', 'B', 'C']) game.addPlayer(id, id, null);
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
  assert.strictEqual(b.shown, false);
  assert.strictEqual(b.handName, null);
});

test('3.7 result 净收益之和为 0（零和）', () => {
  const game = new PokerGame('test');
  for (const id of ['A', 'B', 'C']) game.addPlayer(id, id, null);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();
  playOut(game);

  if (!game.result) return;
  const netSum = game.result.players.reduce((a, p) => a + p.net, 0);
  assert.strictEqual(netSum, 0, '净收益之和应为 0');
});

test('3.7 result 不重复携带底牌字段', () => {
  const game = new PokerGame('test');
  for (const id of ['A', 'B']) game.addPlayer(id, id, null);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();
  playOut(game);

  if (!game.result) return;
  for (const p of game.result.players) {
    assert.strictEqual(p.holeCards, undefined, 'result 不应携带 holeCards');
    assert.strictEqual(p.hand, undefined, 'result 不应携带 hand');
  }
});

test('3.7 endHand 也有 result，且 shown 全为 false', () => {
  const game = new PokerGame('test');
  for (const id of ['A', 'B']) game.addPlayer(id, id, null);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();
  game.playerAction('A', 'fold');

  assert.ok(game.result);
  assert.ok(game.result.players.every(p => p.shown === false));
});
