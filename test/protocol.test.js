/*
 * Online protocol tests. Run with: npm test  (or: node test/protocol.test.js)
 *
 * Everything here is what decides whether a message from the other device is
 * believed, so the refusals matter as much as the happy paths.
 */
var assert = require('assert');
var P = require('../public/js/protocol.js');

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

function state(moves, extra) {
  var s = P.newState('game-0001', 'w');
  s.moves = moves.slice();
  Object.keys(extra || {}).forEach(function (key) {
    s[key] = extra[key];
  });
  return s;
}

console.log('\nmoves');

test('encode and decode round-trip, including promotion', function () {
  assert.strictEqual(P.encodeMove({ from: 'e2', to: 'e4' }), 'e2e4');
  assert.strictEqual(P.encodeMove({ from: 'e7', to: 'e8', promotion: 'n' }), 'e7e8n');
  assert.deepStrictEqual(P.decodeMove('e7e8q'), { from: 'e7', to: 'e8', promotion: 'q' });
  assert.deepStrictEqual(P.decodeMove('g1f3'), { from: 'g1', to: 'f3' });
});

test('decode rejects anything that is not a coordinate move', function () {
  ['', 'e2', 'e2e9', 'i2i4', 'e7e8k', 'Nf3', null, 42].forEach(function (bad) {
    assert.strictEqual(P.decodeMove(bad), null, String(bad));
  });
});

test('replay accepts a legal game and records who moved', function () {
  var played = P.replay(['e2e4', 'e7e5', 'g1f3']);
  assert.ok(played);
  assert.deepStrictEqual(played.colors, ['w', 'b', 'w']);
  assert.strictEqual(played.game.turn(), 'b');
});

test('replay refuses illegal and non-canonical moves', function () {
  assert.strictEqual(P.replay(['e2e5']), null);
  assert.strictEqual(P.replay(['e2e4', 'e2e4']), null);
  // A promotion letter on an ordinary move would make duplicates compare unequal.
  assert.strictEqual(P.replay(['e2e4q']), null);
});

test('colours follow the host', function () {
  assert.strictEqual(P.colorFor('host', 'b'), 'b');
  assert.strictEqual(P.colorFor('guest', 'b'), 'w');
});

console.log('\nstate validation');

test('a well-formed state passes', function () {
  assert.ok(P.validState(state(['e2e4', 'e7e5'])));
});

test('malformed or illegal states are refused', function () {
  assert.ok(!P.validState(null));
  assert.ok(!P.validState(state(['e2e4'], { game: 'x' })));
  assert.ok(!P.validState(state(['e2e4'], { rev: -1 })));
  assert.ok(!P.validState(state(['e2e4'], { hostColor: 'red' })));
  assert.ok(!P.validState(state(['e2e4', 'e2e4'])));
  assert.ok(!P.validState(state([], { outcome: { winner: 'w', reason: 'boredom' } })));
});

console.log('\nmerging');

test('with nothing yet, the other side\'s state is adopted', function () {
  var r = P.mergeState(null, state(['e2e4']), false);
  assert.ok(r.changed);
  assert.deepStrictEqual(r.state.moves, ['e2e4']);
  assert.ok(!r.sendBack);
});

test('an empty sync from the other side makes us send ours', function () {
  var r = P.mergeState(state([]), null, true);
  assert.ok(!r.changed);
  assert.ok(r.sendBack);
});

test('identical states need nothing', function () {
  var r = P.mergeState(state(['e2e4']), state(['e2e4']), true);
  assert.ok(!r.changed && !r.sendBack);
});

test('when we are ahead we send back', function () {
  var r = P.mergeState(state(['e2e4', 'e7e5']), state(['e2e4']), false);
  assert.ok(!r.changed);
  assert.ok(r.sendBack);
});

test('the other side\'s missed move is picked up', function () {
  // Host is white; guest (black) played e7e5 while we were offline.
  var r = P.mergeState(state(['e2e4']), state(['e2e4', 'e7e5']), true);
  assert.ok(r.changed);
  assert.deepStrictEqual(r.state.moves, ['e2e4', 'e7e5']);
  assert.ok(!r.sendBack);
});

test('moves for our own colour cannot be slipped in', function () {
  // Host is white; a state adding a white move we never played is refused.
  var r = P.mergeState(state(['e2e4', 'e7e5']), state(['e2e4', 'e7e5', 'g1f3']), true);
  assert.ok(!r.changed);
  assert.strictEqual(r.notice, 'rejected');
  assert.ok(!r.sendBack, 'refusing must not start a ping-pong');
});

test('a higher revision wins outright, even if shorter', function () {
  var mine = state(['e2e4', 'e7e5', 'g1f3']);
  var theirs = state(['e2e4'], { rev: 1 });
  var r = P.mergeState(mine, theirs, true);
  assert.ok(r.changed);
  assert.strictEqual(r.notice, 'reset');
  assert.deepStrictEqual(r.state.moves, ['e2e4']);
});

test('an older revision is ignored and answered with ours', function () {
  var mine = state(['e2e4'], { rev: 2 });
  var r = P.mergeState(mine, state(['e2e4', 'e7e5', 'g1f3']), false);
  assert.ok(!r.changed);
  assert.ok(r.sendBack);
});

test('when copies disagree the host keeps its own and the guest adopts it', function () {
  var hostSide = P.mergeState(state(['e2e4']), state(['d2d4']), true);
  assert.ok(!hostSide.changed && hostSide.sendBack);
  assert.strictEqual(hostSide.notice, 'diverged');

  var guestSide = P.mergeState(state(['d2d4']), state(['e2e4']), false);
  assert.ok(guestSide.changed && !guestSide.sendBack);
  assert.deepStrictEqual(guestSide.state.moves, ['e2e4']);
});

test('an invalid state is refused without replying', function () {
  var r = P.mergeState(state(['e2e4']), state(['e2e4', 'e7e4']), true);
  assert.strictEqual(r.notice, 'rejected');
  assert.ok(!r.changed && !r.sendBack);
});

test('merging never aliases the other side\'s arrays', function () {
  var theirs = state(['e2e4']);
  var r = P.mergeState(null, theirs, false);
  theirs.moves.push('e7e5');
  assert.deepStrictEqual(r.state.moves, ['e2e4']);
});

console.log('\nmove messages');

test('the next legal move by the other side is applied', function () {
  // We are the host (white); black replies.
  var body = { t: 'move', rev: 0, ply: 1, m: 'e7e5' };
  assert.strictEqual(P.checkMove(state(['e2e4']), body, 'b'), 'apply');
});

test('a repeat of a move we already have is a duplicate', function () {
  var body = { t: 'move', rev: 0, ply: 1, m: 'e7e5' };
  assert.strictEqual(P.checkMove(state(['e2e4', 'e7e5']), body, 'b'), 'duplicate');
});

test('gaps and revision mismatches ask for a resync', function () {
  assert.strictEqual(P.checkMove(state([]), { rev: 0, ply: 1, m: 'e7e5' }, 'b'), 'resync');
  assert.strictEqual(P.checkMove(state(['e2e4']), { rev: 1, ply: 1, m: 'e7e5' }, 'b'), 'resync');
  assert.strictEqual(P.checkMove(null, { rev: 0, ply: 0, m: 'e2e4' }, 'w'), 'resync');
});

test('illegal moves and moves out of turn are rejected', function () {
  assert.strictEqual(P.checkMove(state(['e2e4']), { rev: 0, ply: 1, m: 'e7e4' }, 'b'), 'reject');
  // It is black's turn, but the sender plays white.
  assert.strictEqual(P.checkMove(state(['e2e4']), { rev: 0, ply: 1, m: 'e7e5' }, 'w'), 'reject');
});

test('no moves are accepted once the game has a result', function () {
  var over = state(['e2e4'], { outcome: { winner: 'w', reason: 'resignation' } });
  assert.strictEqual(P.checkMove(over, { rev: 0, ply: 1, m: 'e7e5' }, 'b'), 'reject');
});

console.log('\nrequests');

test('take-back removes one ply if the opponent has not replied', function () {
  assert.strictEqual(P.takebackPlies(['e2e4'], 'w'), 1);
  assert.strictEqual(P.takebackPlies(['e2e4', 'e7e5', 'g1f3'], 'w'), 1);
});

test('take-back removes two plies if the opponent has replied', function () {
  assert.strictEqual(P.takebackPlies(['e2e4', 'e7e5'], 'w'), 2);
});

test('take-back with nothing to take back is refused', function () {
  assert.strictEqual(P.takebackPlies([], 'w'), 0);
  assert.strictEqual(P.takebackPlies(['e2e4'], 'b'), 0);
  assert.strictEqual(P.resolveRequest(state(['e2e4']), 'takeback', 'req-00001', 'b'), null);
});

test('accepting a take-back bumps the revision', function () {
  var next = P.resolveRequest(state(['e2e4', 'e7e5']), 'takeback', 'req-00001', 'w');
  assert.deepStrictEqual(next.moves, []);
  assert.strictEqual(next.rev, 1);
});

test('an agreed draw records the outcome', function () {
  var next = P.resolveRequest(state(['e2e4']), 'draw', 'req-00001', 'w');
  assert.deepStrictEqual(next.outcome, { winner: null, reason: 'agreement' });
  assert.strictEqual(P.outcomeText(next.outcome), 'Draw agreed');
});

test('a new game swaps colours and takes the request id', function () {
  var next = P.resolveRequest(state(['e2e4']), 'newgame', 'req-00001', 'w');
  assert.strictEqual(next.game, 'req-00001');
  assert.strictEqual(next.hostColor, 'b');
  assert.deepStrictEqual(next.moves, []);
  assert.strictEqual(next.rev, 1);
});

test('nothing but a new game once the board shows a result', function () {
  var mated = state(['f2f3', 'e7e5', 'g2g4', 'd8h4']); // fool's mate
  assert.strictEqual(P.resolveRequest(mated, 'draw', 'req-00001', 'w'), null);
  assert.strictEqual(P.resign(mated, 'w'), null);
  assert.ok(P.resolveRequest(mated, 'newgame', 'req-00001', 'w'));
});

test('resigning awards the game to the other side', function () {
  var next = P.resign(state(['e2e4']), 'b');
  assert.deepStrictEqual(next.outcome, { winner: 'w', reason: 'resignation' });
  assert.strictEqual(P.outcomeText(next.outcome), 'Black resigned — White wins');
});

console.log('\nenvelopes');

test('a message from the other role with a newer counter is accepted', function () {
  var body = { t: 'sync', state: null };
  assert.deepStrictEqual(P.unwrap(P.wrap('guest', 5, body), 'host', 4), body);
});

test('reflected messages are ignored', function () {
  assert.strictEqual(P.unwrap(P.wrap('host', 5, { t: 'sync', state: null }), 'host', 0), null);
});

test('replayed messages are ignored', function () {
  assert.strictEqual(P.unwrap(P.wrap('guest', 4, { t: 'sync', state: null }), 'host', 4), null);
});

test('malformed bodies are ignored', function () {
  assert.strictEqual(P.unwrap(P.wrap('guest', 9, { t: 'move', rev: 0, ply: 0, m: 'xx' }), 'host', 0), null);
  assert.strictEqual(P.unwrap(P.wrap('guest', 9, { t: 'request', id: 'req-00001', kind: 'win' }), 'host', 0), null);
  assert.strictEqual(P.unwrap(P.wrap('guest', 9, { t: 'shout' }), 'host', 0), null);
  assert.strictEqual(P.unwrap({ from: 'guest', n: 9, body: { t: 'sync', state: null } }, 'host', 0), null);
});

console.log('\nlinks');

test('relay addresses are normalised to an HTTPS origin', function () {
  assert.strictEqual(P.normalizeRelay('chess-relay.alice.workers.dev'), 'https://chess-relay.alice.workers.dev');
  assert.strictEqual(P.normalizeRelay(' https://relay.example.com/some/path '), 'https://relay.example.com');
  assert.strictEqual(P.normalizeRelay('http://localhost:8787'), 'http://localhost:8787');
});

test('unsafe relay addresses are refused', function () {
  ['', 'http://relay.example.com', 'ftp://relay.example.com', 'https://user:pw@relay.example.com', 'not a url'].forEach(
    function (bad) {
      assert.strictEqual(P.normalizeRelay(bad), null, bad);
    }
  );
});

test('socket URLs follow the page\'s scheme', function () {
  assert.strictEqual(P.socketUrl('https://r.example.com', 'abc'), 'wss://r.example.com/v1/rooms/abc');
  assert.strictEqual(P.socketUrl('http://localhost:8787', 'abc'), 'ws://localhost:8787/v1/rooms/abc');
});

test('an invite link round-trips', function () {
  var link = P.inviteLink('https://x.github.io/Farboard/', 'AAAAAAAAAAAAAAAAAAAAAA', 'https://relay.example.com');
  assert.strictEqual(link, 'https://x.github.io/Farboard/#join=AAAAAAAAAAAAAAAAAAAAAA&relay=relay.example.com');
  assert.deepStrictEqual(P.parseLink(link), {
    join: { secret: 'AAAAAAAAAAAAAAAAAAAAAA', relay: 'https://relay.example.com' }
  });
});

test('a local relay survives the round-trip', function () {
  var link = P.inviteLink('http://localhost:8000/', 'AAAAAAAAAAAAAAAAAAAAAA', 'http://localhost:8787');
  assert.strictEqual(P.parseLink(link).join.relay, 'http://localhost:8787');
});

test('a setup link round-trips', function () {
  var key = 'k'.repeat(43);
  var link = P.setupLink('https://x.github.io/Farboard/', 'https://relay.example.com', key);
  assert.deepStrictEqual(P.parseLink(link), { setup: { relay: 'https://relay.example.com', key: key } });
});

test('broken links parse to nothing', function () {
  assert.strictEqual(P.parseLink(''), null);
  assert.strictEqual(P.parseLink('#join=short&relay=relay.example.com'), null);
  assert.strictEqual(P.parseLink('#join=AAAAAAAAAAAAAAAAAAAAAA'), null);
  assert.strictEqual(P.parseLink('#join=AAAAAAAAAAAAAAAAAAAAAA&relay=http://evil.example.com'), null);
  assert.strictEqual(P.parseLink('#relay-setup=relay.example.com&key=short'), null);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
