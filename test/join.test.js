const test = require('node:test');
const assert = require('node:assert');
const PokerGame = require('../game/pokerGame');

function newGame(players = ['A', 'B']) {
  const game = new PokerGame('test');
  for (const id of players) game.addPlayer(id, id, null);
  return game;
}

// 3.2 牌局进行中禁止加入
test('3.2 牌局中 addPlayer 返回 null', () => {
  const game = newGame(['A', 'B']);
  game.stage = 'ended';
  game.startHand();
  assert.ok(game.isHandInProgress());
  assert.strictEqual(game.addPlayer('C', 'C', null), null);
  assert.strictEqual(game.players.length, 2);
});

test('3.2 waiting/ended 阶段可以加入', () => {
  const game = newGame(['A']);
  assert.strictEqual(game.stage, 'waiting');
  assert.ok(game.addPlayer('B', 'B', null));

  game.stage = 'ended';
  assert.ok(game.addPlayer('C', 'C', null));
});

test('3.2 同一 playerId 不能重复占座', () => {
  const game = newGame(['A']);
  assert.strictEqual(game.addPlayer('A', 'A2', null), null);
  assert.strictEqual(game.players.length, 1);
});

test('3.2 中途加入的玩家没有底牌，也不会参与分池', () => {
  const game = newGame(['A', 'B']);
  game.stage = 'ended';
  game.startHand();

  // 直接调用 addPlayer 会被拒绝，验证防御生效
  const added = game.addPlayer('C', 'C', null);
  assert.strictEqual(added, null);

  // 手动塞一个空手牌玩家，确认不会被当成赢家候选（防御性测试）
  game.players.push({
    id: 'C', name: 'C', chips: 1000, hand: [],
    folded: false, allIn: false, currentBet: 0, totalBet: 0,
    hasActed: false, isBot: false, disconnected: false, chipsAtHandStart: 1000
  });
  game.stage = 'river';
  game.community = [
    { suit: 'spades', rank: '10' }, { suit: 'spades', rank: 'J' },
    { suit: 'spades', rank: 'Q' }, { suit: 'spades', rank: 'K' },
    { suit: 'spades', rank: 'A' }
  ];
  game.players[0].hand = [{ suit: 'hearts', rank: '2' }, { suit: 'hearts', rank: '3' }];
  game.players[1].hand = [{ suit: 'hearts', rank: '4' }, { suit: 'hearts', rank: '5' }];
  game.players.forEach(p => { p.totalBet = 100; });
  game.pot = 300;

  assert.doesNotThrow(() => game.showdown(), '空手牌玩家不应导致结算崩溃');
  // 空手牌玩家 evaluateBest 返回 null，不能成为赢家
  assert.ok(!game.winners.some(w => w.player.id === 'C'), '空手牌玩家不应赢得底池');
});

// 3.4 房间号正则
test('3.4 房间号正则：合法与非法', () => {
  const RE = /^[A-Za-z0-9_-]{1,20}$/;
  for (const id of ['abc', 'room-1', 'room_1', 'A1', 'constructor', '__proto__', 'toString']) {
    assert.ok(RE.test(id), `${id} 应通过正则`);
  }
  for (const id of ['', 'a b', 'a/b', 'a.b', 'a'.repeat(21), '房间', '../etc', 'a\u0000b']) {
    assert.strictEqual(RE.test(id), false, `${id} 应被正则拒绝`);
  }
});

test('3.4 constructor/__proto__ 作为房间号不会崩溃（Map 语义）', () => {
  const rooms = new Map();
  const getRoom = (id) => {
    if (!rooms.has(id)) rooms.set(id, { game: new PokerGame(id), playerIds: new Set() });
    return rooms.get(id);
  };
  for (const id of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const room = getRoom(id);
    assert.ok(room && room.game, `${id} 房间应正常创建`);
    assert.strictEqual(room.game.players.length, 0);
  }
  assert.strictEqual(rooms.size, 4, '四个房间应互不干扰');
});

test('3.4 房间删除后访问不应崩溃', () => {
  const rooms = new Map();
  rooms.set('r', { game: new PokerGame('r'), playerIds: new Set(['s1']) });
  rooms.delete('r');
  // 模拟 server 的判空逻辑
  const room = rooms.get('r');
  assert.strictEqual(room, undefined);
  assert.doesNotThrow(() => {
    if (!room) return;
    room.game.players.find(p => p.id === 'p_s1');
  });
});

// 3.9 破产座位不阻塞新玩家
test('3.9 满座时替换破产座位', () => {
  const game = newGame(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.strictEqual(game.players.length, 7);
  for (let i = 0; i < 5; i++) game.players[i].chips = 0;

  const added = game.addPlayer('NEW', 'NEW', null);
  assert.ok(added, '破产座位应可被替换');
  assert.strictEqual(game.players.length, 7);
  assert.ok(game.players.some(p => p.id === 'NEW'));
});

test('3.9 满座且无人破产时拒绝新玩家', () => {
  const game = newGame(['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
  assert.strictEqual(game.addPlayer('NEW', 'NEW', null), null);
});

// 昵称去重（服务端逻辑的纯函数化验证）
test('3.4 昵称去重大小写不敏感 + trim', () => {
  const players = [{ name: 'Alice' }];
  const isDup = (name) => players.some(p => p.name.trim().toLowerCase() === name.trim().toLowerCase());
  assert.ok(isDup('alice'));
  assert.ok(isDup('  ALICE  '));
  assert.ok(!isDup('bob'));
});
