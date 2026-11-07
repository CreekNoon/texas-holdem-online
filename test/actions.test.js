const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

function newGame(players = ['A', 'B']) {
  const game = new PokerGame('test');
  for (const id of players) game.addPlayer(id, id, null);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();
  return game;
}

test('3.3 非法 action 字符串被拒绝', () => {
  const game = newGame();
  const current = game.players[game.currentPlayerIndex].id;
  for (const action of ['bet', 'RAISE', '', null, undefined, 123, {}]) {
    assert.strictEqual(game.playerAction(current, action, 0), false, `action=${String(action)} 应被拒绝`);
  }
});

test('3.3 raise 金额必须有限正整数', () => {
  const game = newGame();
  const current = game.players[game.currentPlayerIndex].id;
  const before = {
    chips: game.players.map(p => p.chips),
    pot: game.pot,
    currentBet: game.currentBet
  };

  for (const amount of [NaN, Infinity, -Infinity, -1, 0, 1.5, 'abc', null, undefined, {}, []]) {
    assert.strictEqual(game.playerAction(current, 'raise', amount), false, `amount=${String(amount)} 应被拒绝`);
    assert.deepStrictEqual(game.players.map(p => p.chips), before.chips, '状态不应变化');
    assert.strictEqual(game.pot, before.pot);
    assert.strictEqual(game.currentBet, before.currentBet);
  }
});

test('3.3 所有筹码字段始终为有限整数', () => {
  const game = newGame(['A', 'B', 'C']);
  for (let i = 0; i < 50 && game.stage !== 'ended'; i++) {
    const cur = game.players[game.currentPlayerIndex];
    if (!cur) break;
    const call = Math.max(0, game.currentBet - cur.currentBet);
    const ok = game.playerAction(cur.id, call === 0 ? 'check' : 'call', 0);
    if (!ok) game.playerAction(cur.id, 'fold', 0);
  }
  for (const p of game.players) {
    assert.ok(Number.isSafeInteger(p.chips), `${p.id} chips 非整数: ${p.chips}`);
    assert.ok(Number.isSafeInteger(p.currentBet), `${p.id} currentBet 非整数`);
    assert.ok(Number.isSafeInteger(p.totalBet), `${p.id} totalBet 非整数`);
  }
  assert.ok(Number.isSafeInteger(game.pot), `pot 非整数: ${game.pot}`);
});

test('3.3 非当前玩家无法行动', () => {
  const game = newGame(['A', 'B', 'C']);
  const current = game.players[game.currentPlayerIndex].id;
  const other = game.players.find(p => p.id !== current).id;
  assert.strictEqual(game.playerAction(other, 'check', 0), false);
  assert.strictEqual(game.playerAction(other, 'fold', 0), false);
});

test('3.3 已弃牌/已全押玩家无法行动', () => {
  const game = newGame(['A', 'B']);
  const current = game.players[game.currentPlayerIndex];
  current.folded = true;
  assert.strictEqual(game.playerAction(current.id, 'check', 0), false);

  const other = game.players.find(p => p.id !== current.id);
  other.allIn = true;
  assert.strictEqual(game.playerAction(other.id, 'check', 0), false);
});

test('3.3 check 在有跟注额时被拒绝', () => {
  const game = newGame(['A', 'B']);
  const current = game.players[game.currentPlayerIndex].id;
  // 大盲已下注，翻牌前首位行动者有跟注额
  assert.ok(game.currentBet > 0);
  assert.strictEqual(game.playerAction(current, 'check', 0), false);
});

test('3.3 不足额加注被拒绝', () => {
  const game = newGame(['A', 'B']);
  const cur = game.players[game.currentPlayerIndex];
  const callAmount = game.currentBet - cur.currentBet;

  // 把筹码压到刚好只能跟注：任何 raise 都会被 clamp 到 callAmount，必须被拒绝
  cur.chips = callAmount;
  assert.strictEqual(game.playerAction(cur.id, 'raise', game.currentBet + game.minRaise), false);
  assert.strictEqual(cur.chips, callAmount, '被拒绝时筹码不应变化');
});
