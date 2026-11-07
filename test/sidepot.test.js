const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

const card = (suit, rank) => ({ suit, rank });

function newGame(players, config = {}) {
  const game = new PokerGame('test', config);
  for (const id of players) game.addPlayer(id, id, null);
  return game;
}

// 3.1 复现 1：A 全押 1000，B 小盲 10 弃牌，C 全押 1000 → 总筹码 3000 守恒
test('3.1 复现1：弃牌死钱进入边池，总筹码 3000 → 3000', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  assert.ok(game.startHand());

  game.playerAction('A', 'allin');
  game.playerAction('B', 'fold');
  game.playerAction('C', 'allin');

  assert.strictEqual(game.stage, 'ended');
  assert.strictEqual(game.players.reduce((a, p) => a + p.chips, 0), 3000, '总筹码必须守恒');

  // 底池 2010（含 B 的死钱 10）全部由 A/C 竞争，B 保留自己的 990
  const b = game.players.find(p => p.id === 'B');
  assert.strictEqual(b.chips, 990);
  const a = game.players.find(p => p.id === 'A');
  const c = game.players.find(p => p.id === 'C');
  assert.strictEqual(a.chips + c.chips, 2010, '死钱必须进入 A/C 竞争的池');
});

test('3.1 复现1：A/C 手牌相同时平分 2010（各 1005）', () => {
  const game = newGame(['A', 'B', 'C'], { startingChips: 1000 });
  game.stage = 'river';
  game.buttonIndex = 0;

  // 直接构造结算前状态：A/C 各投 1000 且手牌同牌力，B 投 10 已弃牌
  game.community = [
    card('spades', '2'), card('hearts', '3'), card('diamonds', '4'),
    card('clubs', '5'), card('spades', '9')
  ];
  const a = game.players.find(p => p.id === 'A');
  const b = game.players.find(p => p.id === 'B');
  const c = game.players.find(p => p.id === 'C');

  a.hand = [card('hearts', 'A'), card('hearts', 'K')];
  c.hand = [card('diamonds', 'A'), card('diamonds', 'K')];
  b.hand = [card('clubs', '2'), card('clubs', '7')];

  a.totalBet = 1000; a.chips = 0; a.allIn = true;
  b.totalBet = 10; b.chips = 990; b.folded = true;
  c.totalBet = 1000; c.chips = 0; c.allIn = true;
  game.pot = 2010;

  game.showdown();

  assert.deepStrictEqual(
    Object.fromEntries(game.players.map(p => [p.id, p.chips])),
    { A: 1005, B: 990, C: 1005 }
  );
});

// 3.1 复现 2：未跟注超额必须退还，不能给赢家
test('3.1 复现2：未跟注超额退还，1100 → 1100', () => {
  const game = newGame(['A', 'B'], { startingChips: 1000 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.players[1].chips = 100; // 初始总筹码 1100
  assert.ok(game.startHand());

  game.playerAction('A', 'raise', 300);
  game.playerAction('B', 'allin');
  assert.strictEqual(game.stage, 'flop');

  game.playerAction('A', 'fold');

  const byId = Object.fromEntries(game.players.map(p => [p.id, p.chips]));
  assert.deepStrictEqual(byId, { A: 900, B: 200 });
  assert.strictEqual(game.players.reduce((a, p) => a + p.chips, 0), 1100);
});

// 3.1 死钱层级：必须按“层”退，不能按“人”退
test('3.1 死钱层级按层退款：A 退 700、C 退 500、B 赢 900', () => {
  const game = newGame(['A', 'B', 'C']);
  game.stage = 'river';

  game.players[0].totalBet = 1000;
  game.players[0].folded = true;
  game.players[0].chips = 0;

  game.players[1].totalBet = 300;
  game.players[1].folded = false;
  game.players[1].chips = 0;

  game.players[2].totalBet = 800;
  game.players[2].folded = true;
  game.players[2].chips = 0;

  game.pot = 2100;
  game.endHand();

  const byId = Object.fromEntries(game.players.map(p => [p.id, p.chips]));
  assert.deepStrictEqual(byId, { A: 700, B: 900, C: 500 });
  assert.strictEqual(game.players.reduce((a, p) => a + p.chips, 0), 2100);
  assert.deepStrictEqual(game.winners.map(w => [w.player.id, w.amount]), [['B', 900]]);
});

// 3.1 退款不得进入 winners（否则会通过 reveal 泄露底牌）
test('3.1 退款玩家不出现在 winners', () => {
  const game = newGame(['A', 'B'], { startingChips: 1000 });
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.players[1].chips = 100;
  game.startHand();
  game.playerAction('A', 'raise', 300);
  game.playerAction('B', 'allin');
  game.playerAction('A', 'fold');

  // A 拿到 200 退款，但只能是 winner 之外的身份
  assert.ok(!game.winners.some(w => w.player.id === 'A'), '退款玩家不应出现在 winners');
  const a = game.result.players.find(p => p.id === 'A');
  assert.strictEqual(a.refunded, 200);
  assert.strictEqual(a.won, 0);
});

// 3.1 短筹码 BB 的超额必须退还，不得整池给赢家
test('3.1 短筹码大盲的超额退还', () => {
  const game = newGame(['A', 'B', 'C']);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.players[2].chips = 10; // BB 只有 10，初始总筹码 2010
  game.startHand();

  game.playerAction('A', 'call');
  game.playerAction('B', 'call');

  assert.strictEqual(game.stage, 'flop');
  // A/B 各投 20、C 只投 10 → 底池 50；C 未跟注的 10 已在结算时退还，
  // 进行中底池应等于 Σ totalBet
  assert.strictEqual(game.pot, 50);
  assert.strictEqual(game.players.reduce((a, p) => a + p.totalBet, 0), 50);
  assert.strictEqual(game.players.reduce((a, p) => a + p.chips, 0) + game.pot, 2010);
});

// 3.1 全员弃牌（endHand）也必须有 result
test('3.1 endHand 产出 result', () => {
  const game = newGame(['A', 'B']);
  game.stage = 'ended';
  game.buttonIndex = 0;
  game.startHand();

  game.playerAction('A', 'fold');

  assert.strictEqual(game.stage, 'ended');
  assert.ok(game.result, 'endHand 必须产出 result');
  assert.ok(game.result.pots.length > 0);
  assert.strictEqual(game.result.players.every(p => p.shown === false), true);
});

// 3.1 结算断言：showdown 与 endHand 走同一套逻辑
test('3.1 showdown 与 endHand 共用结算逻辑', () => {
  const game = newGame(['A', 'B']);
  game.stage = 'river';
  game.community = [card('spades', '2'), card('hearts', '7'), card('clubs', 'J'), card('diamonds', '4'), card('spades', '9')];
  game.players[0].totalBet = 100;
  game.players[0].chips = 900;
  game.players[0].hand = [card('hearts', 'A'), card('hearts', 'K')];
  game.players[1].totalBet = 100;
  game.players[1].chips = 900;
  game.players[1].hand = [card('clubs', 'A'), card('clubs', 'K')];
  game.pot = 200;

  game.showdown();

  assert.strictEqual(game.stage, 'ended');
  assert.strictEqual(game.pot, 0);
  assert.strictEqual(game.players.reduce((a, p) => a + p.chips, 0), 2000);
  // 双方牌力相同，平分
  assert.strictEqual(game.players[0].chips + game.players[1].chips, 2000);
});
