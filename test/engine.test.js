/*
 * Engine tests. Run with: npm test  (or: node test/engine.test.js)
 *
 * The perft cases are the standard published node counts for well-known
 * positions — if move generation, castling, en passant, or promotion is wrong
 * anywhere, these numbers diverge immediately.
 */
var assert = require('assert');
var Chess = require('../public/js/chess.js').Chess;

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

function perft(game, depth) {
  if (depth === 0) return 1;
  var moves = game._generateMoves();
  if (depth === 1) return moves.length;
  var nodes = 0;
  for (var i = 0; i < moves.length; i++) {
    game._makeMove(moves[i]);
    nodes += perft(game, depth - 1);
    game._undoMove();
  }
  return nodes;
}

console.log('\nperft');

test('initial position, depth 1-4', function () {
  var game = new Chess();
  assert.strictEqual(perft(game, 1), 20);
  assert.strictEqual(perft(game, 2), 400);
  assert.strictEqual(perft(game, 3), 8902);
  assert.strictEqual(perft(game, 4), 197281);
});

test('kiwipete, depth 1-3 (castling, pins, en passant)', function () {
  var game = new Chess('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.strictEqual(perft(game, 1), 48);
  assert.strictEqual(perft(game, 2), 2039);
  assert.strictEqual(perft(game, 3), 97862);
});

test('position 3, depth 1-4 (en passant edge cases)', function () {
  var game = new Chess('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.strictEqual(perft(game, 1), 14);
  assert.strictEqual(perft(game, 2), 191);
  assert.strictEqual(perft(game, 3), 2812);
  assert.strictEqual(perft(game, 4), 43238);
});

test('position 4, depth 1-3 (promotions)', function () {
  var game = new Chess('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
  assert.strictEqual(perft(game, 1), 6);
  assert.strictEqual(perft(game, 2), 264);
  assert.strictEqual(perft(game, 3), 9467);
});

test('position 5, depth 1-3', function () {
  var game = new Chess('rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8');
  assert.strictEqual(perft(game, 1), 44);
  assert.strictEqual(perft(game, 2), 1486);
  assert.strictEqual(perft(game, 3), 62379);
});

console.log('\nmake / undo');

test('undo restores the exact position', function () {
  var game = new Chess();
  var before = game.fen();
  game.move({ from: 'e2', to: 'e4' });
  game.move({ from: 'c7', to: 'c5' });
  game.undo();
  game.undo();
  assert.strictEqual(game.fen(), before);
});

test('castling moves the rook and clears the rights', function () {
  var game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  game.move({ from: 'e1', to: 'g1' });
  assert.strictEqual(game.get('g1').type, 'k');
  assert.strictEqual(game.get('f1').type, 'r');
  assert.strictEqual(game.get('h1'), null);
  assert.strictEqual(game.fen().split(' ')[2], 'kq');
});

test('undoing a castle puts the rook back', function () {
  var game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  var before = game.fen();
  game.move({ from: 'e1', to: 'c1' });
  game.undo();
  assert.strictEqual(game.fen(), before);
});

test('en passant removes the captured pawn', function () {
  var game = new Chess();
  game.move({ from: 'e2', to: 'e4' });
  game.move({ from: 'a7', to: 'a6' });
  game.move({ from: 'e4', to: 'e5' });
  game.move({ from: 'd7', to: 'd5' });
  var move = game.move({ from: 'e5', to: 'd6' });
  assert.strictEqual(move.flags.indexOf('e') !== -1, true);
  assert.strictEqual(game.get('d5'), null);
  assert.strictEqual(game.get('d6').color, 'w');
});

test('promotion produces the chosen piece', function () {
  var game = new Chess('8/P6k/8/8/8/8/7K/8 w - - 0 1');
  game.move({ from: 'a7', to: 'a8', promotion: 'n' });
  assert.strictEqual(game.get('a8').type, 'n');
  game.undo();
  assert.strictEqual(game.get('a7').type, 'p');
});

console.log('\nlegality');

test('a pinned piece cannot move', function () {
  // The bishop on e2 is pinned against its king by the rook on e7.
  var game = new Chess('4k3/4r3/8/8/8/8/4B3/4K3 w - - 0 1');
  assert.strictEqual(game.moves({ square: 'e2' }).length, 0);
});

test('moves from a square are filtered to that square', function () {
  var game = new Chess();
  var moves = game.moves({ square: 'g1', verbose: true });
  assert.deepStrictEqual(
    moves.map(function (m) {
      return m.to;
    }).sort(),
    ['f3', 'h3']
  );
});

test('checkmate is detected', function () {
  var game = new Chess();
  ['f3', 'e5', 'g4', 'Qh4'].forEach(function (san) {
    assert.ok(game.move(san), 'move rejected: ' + san);
  });
  assert.strictEqual(game.isCheckmate(), true);
  assert.strictEqual(game.status().result, '0-1');
});

test('stalemate is detected', function () {
  var game = new Chess('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.strictEqual(game.isStalemate(), true);
  assert.strictEqual(game.isCheckmate(), false);
});

test('illegal moves are rejected', function () {
  var game = new Chess();
  assert.strictEqual(game.move({ from: 'e2', to: 'e5' }), null);
  assert.strictEqual(game.move('Ke2'), null);
  assert.strictEqual(game.moveCount(), 0);
});

test('insufficient material', function () {
  assert.strictEqual(new Chess('8/8/4k3/8/8/3K4/8/8 w - - 0 1').isInsufficientMaterial(), true);
  assert.strictEqual(new Chess('8/8/4k3/8/8/3K1B2/8/8 w - - 0 1').isInsufficientMaterial(), true);
  assert.strictEqual(new Chess('8/8/4k3/8/8/3K1R2/8/8 w - - 0 1').isInsufficientMaterial(), false);
});

test('threefold repetition', function () {
  var game = new Chess();
  ['Nf3', 'Nf6', 'Ng1', 'Ng8', 'Nf3', 'Nf6', 'Ng1', 'Ng8'].forEach(function (san) {
    assert.ok(game.move(san), 'move rejected: ' + san);
  });
  assert.strictEqual(game.isThreefoldRepetition(), true);
});

test('an unusable en passant square does not split a repetition', function () {
  // The position after 1.e4 comes back twice. Nobody can ever capture on e3,
  // so all three occurrences are the same position.
  var game = new Chess();
  ['e4', 'Nf6', 'Nf3', 'Ng8', 'Ng1', 'Nf6', 'Nf3', 'Ng8', 'Ng1'].forEach(function (san) {
    assert.ok(game.move(san), 'move rejected: ' + san);
  });
  assert.strictEqual(game.isThreefoldRepetition(), true);
});

test('a usable en passant square still distinguishes the position', function () {
  // Black has a pawn on d4, so after c4 the capture cxd3 really is available
  // and that position is not the same as one without the right.
  var game = new Chess('4k3/8/8/8/3p4/8/2P5/4K3 w - - 0 1');
  var withRight = game.move('c4');
  assert.ok(withRight, 'c4 rejected');
  assert.strictEqual(game.fen().split(' ')[3], 'c3');
  assert.strictEqual(game._hasEnPassantCapture(), true);
  assert.ok(game._positionKey().indexOf('c3') !== -1, 'usable right is kept in the key');
});

console.log('\nnotation');

test('SAN disambiguates by file', function () {
  var rooks = new Chess('R6R/8/8/8/8/8/8/4K1k1 w - - 0 1');
  var sans = rooks.moves();
  assert.ok(sans.indexOf('Rad8') !== -1, sans.join(' '));
  assert.ok(sans.indexOf('Rhd8') !== -1, sans.join(' '));
});

test('SAN disambiguates by rank when the file is shared', function () {
  var rooks = new Chess('R7/8/6k1/8/8/8/8/R6K w - - 0 1');
  var sans = rooks.moves();
  assert.ok(sans.indexOf('R1a5') !== -1, sans.join(' '));
  assert.ok(sans.indexOf('R8a5') !== -1, sans.join(' '));
});

test('SAN falls back to the full square when both are shared', function () {
  // Knights on c3, c5 and g3 all reach e4.
  var game = new Chess('4k3/8/8/2N5/8/2N3N1/8/K7 w - - 0 1');
  var sans = game.moves();
  assert.ok(sans.indexOf('Nc3e4') !== -1, sans.join(' '));
  assert.ok(sans.indexOf('N5e4') !== -1, sans.join(' '));
  assert.ok(sans.indexOf('Nge4') !== -1, sans.join(' '));
});

test('SAN marks check and mate', function () {
  // g7 is free, so the king escapes: check, not mate.
  var game = new Chess('6k1/5p1p/8/8/8/8/8/R3K3 w Q - 0 1');
  assert.ok(game.moves().indexOf('Ra8+') !== -1, game.moves().join(' '));
  // Boxed in by its own pawns, so the same idea is mate.
  var mate = new Chess('6k1/5ppp/8/8/8/8/8/R3K3 w Q - 0 1');
  assert.ok(mate.moves().indexOf('Ra8#') !== -1, mate.moves().join(' '));
});

test('castling SAN', function () {
  var game = new Chess('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  var sans = game.moves();
  assert.ok(sans.indexOf('O-O') !== -1);
  assert.ok(sans.indexOf('O-O-O') !== -1);
});

test('history replays SAN correctly', function () {
  var game = new Chess();
  var played = ['e4', 'e5', 'Nf3', 'Nc6', 'Bb5', 'a6'];
  played.forEach(function (san) {
    assert.ok(game.move(san), 'move rejected: ' + san);
  });
  assert.deepStrictEqual(game.history(), played);
  game.undo();
  assert.deepStrictEqual(game.history(), played.slice(0, 5));
});

test('pgn includes numbered moves', function () {
  var game = new Chess();
  ['e4', 'e5', 'Nf3'].forEach(function (san) {
    game.move(san);
  });
  var pgn = game.pgn({ Event: 'Test' });
  assert.ok(pgn.indexOf('[Event "Test"]') !== -1);
  assert.ok(pgn.indexOf('1. e4 e5') !== -1);
  assert.ok(pgn.indexOf('2. Nf3') !== -1);
});

console.log('\nmaterial');

test('starting position is level', function () {
  var m = new Chess().material();
  assert.strictEqual(m.balance, 0);
  assert.deepStrictEqual(m.lost.w, []);
  assert.deepStrictEqual(m.lost.b, []);
});

test('captures are counted for the capturing side', function () {
  var game = new Chess();
  ['e4', 'd5', 'exd5', 'Qxd5'].forEach(function (san) {
    assert.ok(game.move(san), 'move rejected: ' + san);
  });
  var m = game.material();
  assert.deepStrictEqual(m.lost.w, ['p']);
  assert.deepStrictEqual(m.lost.b, ['p']);
  assert.strictEqual(m.balance, 0);
});

test('a missing queen counts as a nine point lead', function () {
  var game = new Chess('rnb1kbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1');
  assert.strictEqual(game.material().balance, 9);
});

test('a promoted pawn is not counted as captured', function () {
  var game = new Chess();
  ['a4', 'h5', 'a5', 'h4', 'a6', 'h3', 'axb7', 'hxg2', 'bxa8=Q'].forEach(function (san) {
    assert.ok(game.move(san), 'move rejected: ' + san);
  });
  var m = game.material();
  // Black captured exactly one pawn; White's other missing pawn promoted.
  assert.deepStrictEqual(m.lost.w, ['p']);
  assert.strictEqual(m.points.b, 1);
  assert.deepStrictEqual(m.lost.b, ['r', 'p']);
  assert.strictEqual(m.points.w, 6);
  // White is a rook and a pawn up, and has a queen for a pawn: 5 + 1 + 8 - 1.
  assert.strictEqual(m.balance, 13);
});

test('promotion alone shows as a material lead', function () {
  var game = new Chess('8/P6k/8/8/8/8/7K/8 w - - 0 1');
  game.move({ from: 'a7', to: 'a8', promotion: 'q' });
  var m = game.material();
  assert.deepStrictEqual(m.lost.w, []);
  assert.deepStrictEqual(m.lost.b, []);
  assert.strictEqual(m.balance, 9);
});

test('material follows the position when stepping back', function () {
  var game = new Chess();
  ['e4', 'd5', 'exd5'].forEach(function (san) {
    game.move(san);
  });
  assert.deepStrictEqual(game.material().lost.b, ['p']);
  game.undo();
  assert.deepStrictEqual(game.material().lost.b, []);
  assert.strictEqual(game.material().balance, 0);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
