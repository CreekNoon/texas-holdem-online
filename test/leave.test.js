const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

function newGame(players = ['A', 'B', 'C'], config = {}) {
  const game = new PokerGame('test', config);
  for (const id of players) game.addPlayer(id, id, null);
  return game;
}

// 3.5 3 人局 A 离开后轮到 B 而不是 C
test('3.5 A 离开后轮到 B 而不是 C', () => {
  const game = newGame();
  game.stage = 'preflop';
  game.currentPlayerIndex = 1; // B 正在行动
  game.buttonIndex = 0;

  assert.strictEqual(game.players[game.currentPlayerIndex].id, 'B');
  game.removePlayer('A');
  assert.strictEqual(game.players[game.currentPlayerIndex].id, 'B', '当前行动者不应跳到 C');
});

test('3.5 移除当前行动者后索引不越界', () => {
  const game = newGame();
  game.stage = 'preflop';
  game.currentPlayerIndex = 2;
  game.removePlayer('C');
  assert.strictEqual(game.players.length, 2);
  assert.ok(game.currentPlayerIndex < game.players.length);
  // 下一次 playerAction 不应抛错
  assert.doesNotThrow(() => game.playerAction('A', 'check', 0));
});

test('3.5 连续多人离开不越界', () => {
  const game = newGame(['A', 'B', 'C', 'D']);
  game.stage = 'preflop';
  game.currentPlayerIndex = 3;
  game.buttonIndex = 3;

  game.removePlayer('A');
  game.removePlayer('B');
  game.removePlayer('C');

  assert.strictEqual(game.players.length, 1);
  assert.strictEqual(game.currentPlayerIndex, 0);
  assert.strictEqual(game.buttonIndex, 0);
});

test('3.5 全部离开后索引归零', () => {
  const game = newGame();
  game.removePlayer('A');
  game.removePlayer('B');
  game.removePlayer('C');
  assert.strictEqual(game.players.length, 0);
  assert.strictEqual(game.currentPlayerIndex, 0);
  assert.strictEqual(game.buttonIndex, 0);
});

test('3.5 牌局中离开保留座位到本局结束', () => {
  const game = newGame();
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  const potBefore = game.pot;
  const totalBetBefore = game.players.reduce((a, p) => a + p.totalBet, 0);

  game.markFolded('B');

  assert.strictEqual(game.players.length, 3, '本局中不应移除座位');
  const b = game.players.find(p => p.id === 'B');
  assert.ok(b.folded, 'B 应被标记弃牌');
  assert.ok(b.disconnected, 'B 应被标记断线');
  // 离开玩家已投入的钱仍在底池
  assert.strictEqual(game.pot, potBefore);
  assert.strictEqual(game.players.reduce((a, p) => a + p.totalBet, 0), totalBetBefore);
});

test('3.5 本局结束后移除断线玩家', () => {
  const game = newGame();
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  game.markFolded('B');
  game.playerAction('A', 'fold');

  assert.strictEqual(game.stage, 'ended');
  assert.ok(!game.players.some(p => p.id === 'B'), 'B 应在本局结束后被移除');
});

test('3.5 离开玩家带走的筹码记入 withdrawnChips', () => {
  const game = newGame();
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  const b = game.players.find(p => p.id === 'B');
  const bChips = b.chips;

  game.markFolded('B');
  game.playerAction('A', 'fold');

  assert.strictEqual(game.withdrawnChips, bChips, '离桌筹码应被记录');
  assert.strictEqual(game.players.reduce((a, p) => a + p.chips, 0) + game.withdrawnChips, 3000);
});

// 3.13 有效按钮位：按钮落在破产玩家上时，翻后首位行动者正确
test('3.5 按钮位为破产玩家时翻后首位行动者正确', () => {
  const game = newGame(['A', 'B', 'C', 'D']);
  game.stage = 'ended';
  game.players[0].chips = 0; // A 破产且是按钮
  game.buttonIndex = 0;
  game.startHand();

  // 有效按钮位应是 B
  assert.strictEqual(game.getEffectiveButtonIndex(), 1);
  // 盲注由 C/D 下
  assert.strictEqual(game.sbIndex, 2);
  assert.strictEqual(game.bbIndex, 3);

  // 所有人过牌/跟注到翻牌
  let guard = 0;
  while (game.stage === 'preflop' && guard++ < 20) {
    const cur = game.players[game.currentPlayerIndex];
    if (!cur) break;
    const call = Math.max(0, game.currentBet - cur.currentBet);
    game.playerAction(cur.id, call === 0 ? 'check' : 'call', 0);
  }

  assert.strictEqual(game.stage, 'flop');
  // 翻牌后首位应是有效按钮位 B 的下一位 C
  assert.strictEqual(game.players[game.currentPlayerIndex].id, 'C');
});

test('3.5 按钮位只在有筹码玩家间轮转', () => {
  const game = newGame(['A', 'B', 'C']);
  game.players[1].chips = 0;
  game.buttonIndex = 0;
  game.advanceButton();
  assert.strictEqual(game.buttonIndex, 2, '应跳过破产的 B');
});

test('3.5 服务端下发 sbIndex/bbIndex', () => {
  const game = newGame();
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  const state = game.getPublicState('p_A');
  assert.ok(state.sbIndex >= 0, 'sbIndex 应下发');
  assert.ok(state.bbIndex >= 0, 'bbIndex 应下发');
  assert.notStrictEqual(state.sbIndex, state.bbIndex);
  // 单挑时 SB 就是按钮
  const game2 = newGame(['A', 'B']);
  game2.stage = 'ended';
  game2.buttonIndex = 0;
  game2.startHand();
  assert.strictEqual(game2.sbIndex, game2.buttonIndex, '单挑时 SB 即按钮位');
});
