/*
 * Chat rules tests. Run with: npm test  (or: node test/chat.test.js)
 */
var assert = require('assert');
var Chat = require('../public/js/chat.js');
var L = Chat.LIMITS;

var passed = 0;
var failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  ok   ' + name);
  } catch (err) {
    failed++;
    console.log('  FAIL ' + name);
    console.log('       ' + err.message);
  }
}

console.log('\ntext and names');

test('text becomes one tidy line', function () {
  assert.strictEqual(Chat.cleanMessage('  hello \n\t  world  '), 'hello world');
  assert.strictEqual(Chat.cleanMessage('a\u0000b\u0007c'), 'a b c');
});

test('hidden and direction-changing characters are removed', function () {
  assert.strictEqual(Chat.cleanMessage('ab​c‮d⁦e﻿'), 'abcde');
  assert.strictEqual(Chat.cleanMessage('👨‍👩‍👧'), '👨‍👩‍👧'); // emoji joiners survive
});

test('length is counted in characters, not code units', function () {
  var long = '😀'.repeat(L.textMax + 50);
  assert.strictEqual(Array.from(Chat.cleanMessage(long)).length, L.textMax);
  assert.strictEqual(Array.from(Chat.cleanName('😀'.repeat(50))).length, L.nameMax);
});

test('non-strings and empty text give nothing', function () {
  [null, undefined, 42, {}, '', '   ', '​'].forEach(function (bad) {
    assert.strictEqual(Chat.cleanMessage(bad), '');
  });
});

test('names cannot pass for the app or the reader', function () {
  ['You', 'SYSTEM', ' farboard ', 'Opponent', 'admin'].forEach(function (bad) {
    assert.strictEqual(Chat.cleanName(bad), '');
  });
  assert.strictEqual(Chat.cleanName('John'), 'John');
});

test('the other player is never labelled with our own name', function () {
  assert.strictEqual(Chat.peerLabel('John', 'Sam'), 'John');
  assert.strictEqual(Chat.peerLabel('sam', 'Sam'), 'sam (opponent)');
  assert.strictEqual(Chat.peerLabel('', 'Sam'), 'Opponent');
});

console.log('\nrate limit');

test('a burst goes through, then messages are paced', function () {
  var b = Chat.freshBucket(0, L.burst);
  for (var i = 0; i < L.burst; i++) {
    b = Chat.takeToken(b, 0, L.burst);
    assert.ok(b, 'message ' + i + ' should pass');
  }
  assert.strictEqual(Chat.takeToken(b, 0, L.burst), null);
  assert.strictEqual(Chat.takeToken(b, 500, L.burst), null);
  assert.ok(Chat.takeToken(b, 1000, L.burst));
});

test('a long silence never banks more than the burst', function () {
  var b = Chat.takeToken(Chat.freshBucket(0, L.burst), 0, L.burst);
  b = Chat.takeToken(b, 10 * 60 * 1000, L.burst);
  for (var i = 0; i < L.burst - 1; i++) b = Chat.takeToken(b, 10 * 60 * 1000, L.burst);
  assert.strictEqual(Chat.takeToken(b, 10 * 60 * 1000, L.burst), null);
});

console.log('\nhistory');

test('history keeps only the latest messages', function () {
  var items = [];
  for (var i = 0; i < L.historyMax + 20; i++) items = Chat.addToHistory(items, { who: 'me', text: 'm' + i });
  assert.strictEqual(items.length, L.historyMax);
  assert.strictEqual(items[items.length - 1].text, 'm' + (L.historyMax + 19));
  assert.strictEqual(items[0].text, 'm20');
});

test('saved history is checked and cleaned when read back', function () {
  var saved = [
    { who: 'peer', text: 'hi‮ there' },
    { who: 'boss', text: 'bad who' },
    { who: 'me', text: '' },
    { who: 'sys', text: 42 },
    null,
    { who: 'me', text: 'ok' }
  ];
  assert.deepStrictEqual(Chat.validHistory(saved), [
    { who: 'peer', text: 'hi there' },
    { who: 'me', text: 'ok' }
  ]);
  assert.deepStrictEqual(Chat.validHistory('nope'), []);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
