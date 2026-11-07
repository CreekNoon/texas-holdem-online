const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

function newGame(players = ['A', 'B']) {
  const game = new PokerGame('test');
  for (const id of players) game.addPlayer(id, id, null);
  return game;
}

test('2.1 玩家拥有稳定 token，且 token 互不相同', () => {
  const game = newGame(['A', 'B']);
  for (const p of game.players) {
    assert.ok(p.token && p.token.length >= 16, 'token 应有足够熵');
  }
  assert.notStrictEqual(game.players[0].token, game.players[1].token, 'token 不应重复');
});

test('2.1 同一玩家不应重复生成 token', () => {
  const game = newGame(['A']);
  const t1 = game.players[0].token;
  game.players[0].chips = 500;
  assert.strictEqual(game.players[0].token, t1, 'token 应保持稳定');
});

test('2.2 findPlayerByToken 校验 token', () => {
  const game = newGame(['A']);
  const p = game.players[0];

  assert.ok(game.findPlayerByToken(p.id, p.token), '正确 token 应通过');
  assert.strictEqual(game.findPlayerByToken(p.id, 'wrong'), null, '错误 token 应拒绝');
  assert.strictEqual(game.findPlayerByToken(p.id, ''), null, '空 token 应拒绝');
  assert.strictEqual(game.findPlayerByToken(p.id, null), null, 'null token 应拒绝');
  assert.strictEqual(game.findPlayerByToken('p_nobody', p.token), null, '不存在的玩家应拒绝');
});

test('2.3 重连轮换 token，旧 token 立即失效', () => {
  const game = newGame(['A']);
  const p = game.players[0];
  const oldToken = p.token;

  const newToken = game.rotateToken(p.id);
  assert.ok(newToken);
  assert.notStrictEqual(newToken, oldToken, 'token 应轮换');
  assert.strictEqual(game.findPlayerByToken(p.id, oldToken), null, '旧 token 应失效');
  assert.ok(game.findPlayerByToken(p.id, newToken), '新 token 应有效');
});

test('2.3 setPlayerConnection 断开/恢复', () => {
  const game = newGame(['A', 'B']);
  const p = game.players[0];

  game.setPlayerConnection(p.id, null, false);
  assert.strictEqual(p.disconnected, true);
  assert.strictEqual(p.socketId, null);
  assert.ok(p.disconnectedAt > 0);

  game.setPlayerConnection(p.id, 'sock-new', true);
  assert.strictEqual(p.disconnected, false);
  assert.strictEqual(p.socketId, 'sock-new');
  assert.strictEqual(p.disconnectedAt, null);
});

test('2.3 断线不立即弃牌，保留手牌与筹码', () => {
  const game = newGame(['A', 'B', 'C']);
  game.stage = 'ended';
  game.startHand();

  const p = game.players.find(x => x.id === 'A');
  const hand = p.hand.slice();
  const chips = p.chips;

  game.markDisconnected(p.id);

  assert.strictEqual(p.disconnected, true, '应标记离线');
  assert.strictEqual(p.folded, false, '断线不应立即弃牌');
  assert.deepStrictEqual(p.hand, hand, '手牌应保留');
  assert.strictEqual(p.chips, chips, '筹码应保留');
  assert.strictEqual(game.players.length, 3, '座位应保留');
});

test('2.6 宽限期到期才弃牌', () => {
  const game = newGame(['A', 'B', 'C']);
  game.stage = 'ended';
  game.startHand();

  const p = game.players.find(x => x.id === 'A');
  game.markDisconnected(p.id);
  assert.strictEqual(p.folded, false);

  game.foldDisconnectedPlayer(p.id);
  assert.strictEqual(p.folded, true, '宽限期到期后应弃牌');
  assert.strictEqual(game.players.length, 3, '座位仍保留到本局结束');
});

test('2.6 all-in 玩家断线不弃牌（筹码已进池）', () => {
  const game = newGame(['A', 'B']);
  game.stage = 'ended';
  game.startHand();

  const p = game.players[game.currentPlayerIndex];
  game.playerAction(p.id, 'allin', 0);
  assert.strictEqual(p.allIn, true);

  game.markDisconnected(p.id);
  game.foldDisconnectedPlayer(p.id);
  assert.strictEqual(p.folded, false, 'all-in 玩家不应被弃牌');
});

test('2.6 显式 leave 立即弃牌（不等宽限期）', () => {
  const game = newGame(['A', 'B', 'C']);
  game.stage = 'ended';
  game.startHand();

  const p = game.players.find(x => x.id === 'A');
  game.markFolded(p.id);
  assert.strictEqual(p.folded, true, '显式离开应立即弃牌');
});

// 回合超时相关：isTurnActive / turnSeq
test('2.4 isTurnActive 只在需要行动的阶段为真', () => {
  const game = newGame(['A', 'B']);
  assert.strictEqual(game.isTurnActive(), false, 'waiting 阶段不活跃');

  game.stage = 'ended';
  game.startHand();
  assert.strictEqual(game.isTurnActive(), true, 'preflop 应活跃');

  const cur = game.players[game.currentPlayerIndex];
  cur.folded = true;
  assert.strictEqual(game.isTurnActive(), false, '弃牌玩家不活跃');

  cur.folded = false;
  cur.allIn = true;
  assert.strictEqual(game.isTurnActive(), false, 'all-in 玩家不活跃');

  cur.allIn = false;
  cur.disconnected = true;
  assert.strictEqual(game.isTurnActive(), false, '断线玩家不计时');

  cur.disconnected = false;
  cur.isBot = true;
  assert.strictEqual(game.isTurnActive(), false, 'bot 不计时');
});

test('2.4 行动者变化时 turnSeq 递增', () => {
  const game = newGame(['A', 'B', 'C']);
  game.stage = 'ended';
  game.startHand();

  const seq0 = game.turnSeq;
  const cur = game.players[game.currentPlayerIndex];
  game.playerAction(cur.id, 'fold', 0);
  assert.ok(game.turnSeq > seq0, '行动后 turnSeq 应递增');
});

test('2.4 同一回合内 turnSeq 不变', () => {
  const game = newGame(['A', 'B', 'C']);
  game.stage = 'ended';
  game.startHand();

  const seq = game.turnSeq;
  game.getPublicState('p_A');
  game.addLog('test');
  assert.strictEqual(game.turnSeq, seq, '只读操作不应改变 turnSeq');
});

test('2.4 turnDeadline 在 ended 阶段为空', () => {
  const game = newGame(['A', 'B']);
  game.stage = 'ended';
  game.startHand();
  game.turnDeadline = Date.now() + 30000;

  game.playerAction(game.players[game.currentPlayerIndex].id, 'fold', 0);
  assert.strictEqual(game.stage, 'ended');
  assert.strictEqual(game.turnDeadline, null, '结束时应清空 deadline');
});

test('2.4 状态协议包含 turnDeadline / turnTimeMs', () => {
  const game = new PokerGame('test', { turnTimeMs: 30000 });
  game.addPlayer('A', 'A', null);
  game.addPlayer('B', 'B', null);
  game.stage = 'ended';
  game.startHand();

  const state = game.getPublicState('p_A');
  assert.strictEqual(state.turnTimeMs, 30000);
  // turnDeadline 由网络层设置；此处未设置时应为 null 而不是 undefined
  assert.strictEqual(state.turnDeadline, null);
});
