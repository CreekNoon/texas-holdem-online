const test = require('node:test');
const assert = require('node:assert');
const { playRandomHand, checkInvariants } = require('../test-support/randomGame');

test('随机 1 万局不变量全绿', () => {
  let fails = 0;
  let skipped = 0;
  const failures = [];

  for (let seed = 0; seed < 10000; seed++) {
    const result = playRandomHand({ seed });
    if (result.skipped) {
      skipped++;
      continue;
    }
    if (result.error) {
      fails++;
      if (failures.length < 5) failures.push({ seed, error: result.error });
    }
  }

  assert.strictEqual(fails, 0, `不变量失败 ${fails} 局:\n${JSON.stringify(failures, null, 2)}`);
  assert.ok(skipped < 1000, `跳过局数异常: ${skipped}`);
});

test('每局结束后 result 金额与底池一致', () => {
  for (let seed = 0; seed < 500; seed++) {
    const result = playRandomHand({ seed });
    if (result.skipped || result.error) continue;
    const game = result.game;
    assert.ok(game.result, `seed ${seed} 结束后缺少 result`);
    assert.strictEqual(game.pot, 0, `seed ${seed} 结束后底池未清零`);
    const potSum = game.result.pots.reduce((a, p) => a + p.amount, 0);
    const wonSum = game.result.players.reduce((a, p) => a + p.won + p.refunded, 0);
    assert.strictEqual(wonSum, potSum, `seed ${seed} 结算金额与边池不一致`);
  }
});

test('currentPlayerIndex 始终合法', () => {
  for (let seed = 0; seed < 500; seed++) {
    const result = playRandomHand({ seed });
    if (result.skipped) continue;
    const game = result.game;
    if (game.players.length === 0) continue;
    assert.ok(game.currentPlayerIndex >= 0 && game.currentPlayerIndex < game.players.length,
      `seed ${seed} currentPlayerIndex 越界: ${game.currentPlayerIndex}/${game.players.length}`);
    assert.ok(game.buttonIndex >= 0 && game.buttonIndex < game.players.length,
      `seed ${seed} buttonIndex 越界: ${game.buttonIndex}/${game.players.length}`);
  }
});
