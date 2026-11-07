const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

function newGame(players, config = {}) {
  const game = new PokerGame('test', config);
  for (const id of players) game.addPlayer(id, id, null);
  return game;
}

test('4.3 前注从每位有筹码玩家扣除并进池', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000, ante: 5 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  // 3 人各 5 前注 + SB 10 + BB 20 = 45
  assert.strictEqual(game.pot, 45);
  assert.ok(game.players.every(p => p.totalBet >= 5), '每位玩家都应投入前注');
});

test('4.3 前注计入 totalBet（保持 pot == Σ totalBet）', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000, ante: 10 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  const totalBet = game.players.reduce((a, p) => a + p.totalBet, 0);
  assert.strictEqual(game.pot, totalBet, 'pot 必须等于 Σ totalBet');
  assert.strictEqual(totalBet, 10 * 3 + 10 + 20);
});

test('4.3 前注不计入 currentBet（不影响跟注额）', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000, ante: 10 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  // currentBet 仍是 BB = 20，不是 20 + ante
  assert.strictEqual(game.currentBet, game.bigBlind);

  const cur = game.players[game.currentPlayerIndex];
  const callAmount = game.currentBet - cur.currentBet;
  assert.strictEqual(callAmount, game.bigBlind - (cur.currentBet || 0));
  assert.ok(callAmount <= game.bigBlind, '跟注额不应包含前注');
});

test('4.3 短筹码前注只扣到 0，不出现负数', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000, ante: 100 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.players[2].chips = 7; // 少于前注
  game.startHand();

  const p = game.players[2];
  assert.strictEqual(p.chips, 0, '筹码不应为负');
  assert.strictEqual(p.allIn, true, '扣光应标记 all-in');
  assert.ok(p.totalBet <= 7, '投入不应超过实际筹码');
});

test('4.3 前注为 0 时不扣（默认行为不变）', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  // 只有 SB 10 + BB 20
  assert.strictEqual(game.pot, 30);
  assert.strictEqual(game.ante, 0);
});

test('4.3 带前注时边池结算仍守恒', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000, ante: 10 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  const initial = game.players.reduce((a, p) => a + p.chips, 0);
  game.startHand();

  // 全员 all-in
  let guard = 0;
  while (['preflop', 'flop', 'turn', 'river'].includes(game.stage) && guard++ < 20) {
    const cur = game.players[game.currentPlayerIndex];
    if (!cur) break;
    if (!game.playerAction(cur.id, 'allin', 0)) {
      const call = Math.max(0, game.currentBet - cur.currentBet);
      game.playerAction(cur.id, call === 0 ? 'check' : 'call', 0);
    }
  }

  assert.strictEqual(game.stage, 'ended');
  assert.strictEqual(game.pot, 0);
  assert.strictEqual(game.players.reduce((a, p) => a + p.chips, 0), initial,
    '带前注时筹码必须守恒');
});

test('4.3 前注随盲注等级变化', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000, ante: 0 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();
  const pot1 = game.pot;

  game.stage = 'ended';
  game.ante = 25;
  game.startHand();
  const pot2 = game.pot;

  assert.ok(pot2 > pot1, '有前注时底池应更大');
  assert.strictEqual(pot2 - pot1, 25 * 3, '差额应等于 ante × 人数');
});
