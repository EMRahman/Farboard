/*
 * Invite-secret and encryption tests. Run with: npm test
 * (or: node test/netcrypto.test.js). Needs Node 20+ for Web Crypto.
 */
var assert = require('assert');
var C = require('../public/js/netcrypto.js');

var passed = 0;
var failed = 0;
var queue = [];

function test(name, fn) {
  queue.push({ name: name, fn: fn });
}

function run() {
  return queue.reduce(function (chain, entry) {
    return chain.then(function () {
      return Promise.resolve()
        .then(entry.fn)
        .then(
          function () {
            passed++;
            console.log('  ok   ' + entry.name);
          },
          function (err) {
            failed++;
            console.log('  FAIL ' + entry.name);
            console.log('       ' + err.message);
          }
        );
    });
  }, Promise.resolve());
}

function rejects(promise) {
  return promise.then(
    function () {
      throw new Error('expected a rejection');
    },
    function () {}
  );
}

var SECRET = 'AAECAwQFBgcICQoLDA0ODw'; // bytes 0..15

console.log('\nnetcrypto');

test('new secrets are 128-bit base64url and differ', function () {
  var a = C.newSecret();
  var b = C.newSecret();
  assert.ok(C.isSecret(a), a);
  assert.strictEqual(C.fromBase64Url(a).length, 16);
  assert.notStrictEqual(a, b);
});

test('base64url round-trips every byte value', function () {
  var bytes = new Uint8Array(256);
  for (var i = 0; i < 256; i++) bytes[i] = i;
  assert.deepStrictEqual(C.fromBase64Url(C.toBase64Url(bytes)), bytes);
  assert.throws(function () {
    C.fromBase64Url('not+base64/url');
  });
});

test('the same secret always derives the same room id', function () {
  return Promise.all([C.deriveRoom(SECRET), C.deriveRoom(SECRET)]).then(function (rooms) {
    assert.strictEqual(rooms[0].roomId, rooms[1].roomId);
    assert.ok(/^[A-Za-z0-9_-]{43}$/.test(rooms[0].roomId), rooms[0].roomId);
  });
});

test('different secrets derive different rooms', function () {
  return Promise.all([C.deriveRoom(SECRET), C.deriveRoom(C.newSecret())]).then(function (rooms) {
    assert.notStrictEqual(rooms[0].roomId, rooms[1].roomId);
  });
});

test('the room id does not reveal the secret', function () {
  return C.deriveRoom(SECRET).then(function (room) {
    assert.ok(room.roomId.indexOf(SECRET) === -1);
  });
});

test('invalid secrets are refused', function () {
  return rejects(C.deriveRoom('too-short'));
});

test('a sealed message opens with a key derived on another device', function () {
  var message = { v: 1, from: 'host', n: 1, body: { t: 'move', rev: 0, ply: 0, m: 'e2e4' } };
  return Promise.all([C.deriveRoom(SECRET), C.deriveRoom(SECRET)]).then(function (rooms) {
    return C.seal(rooms[0].key, message)
      .then(function (frame) {
        assert.ok(/^[A-Za-z0-9_-]+$/.test(frame), 'frames are base64url');
        assert.ok(frame.indexOf('e2e4') === -1, 'frames are not readable');
        return C.open(rooms[1].key, frame);
      })
      .then(function (opened) {
        assert.deepStrictEqual(opened, message);
      });
  });
});

test('sealing the same message twice gives different frames', function () {
  return C.deriveRoom(SECRET).then(function (room) {
    return Promise.all([C.seal(room.key, { a: 1 }), C.seal(room.key, { a: 1 })]).then(function (frames) {
      assert.notStrictEqual(frames[0], frames[1]);
    });
  });
});

test('a tampered frame is rejected', function () {
  return C.deriveRoom(SECRET).then(function (room) {
    return C.seal(room.key, { hello: 'world' }).then(function (frame) {
      var bytes = C.fromBase64Url(frame);
      bytes[bytes.length - 1] ^= 1;
      return rejects(C.open(room.key, C.toBase64Url(bytes)));
    });
  });
});

test('a frame sealed for another game is rejected', function () {
  return Promise.all([C.deriveRoom(SECRET), C.deriveRoom(C.newSecret())]).then(function (rooms) {
    return C.seal(rooms[0].key, { hello: 'world' }).then(function (frame) {
      return rejects(C.open(rooms[1].key, frame));
    });
  });
});

test('short and garbage frames are rejected', function () {
  return C.deriveRoom(SECRET).then(function (room) {
    return Promise.all([rejects(C.open(room.key, 'AAAA')), rejects(C.open(room.key, '{"t":"x"}'))]);
  });
});

run().then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
  process.exit(failed ? 1 : 0);
});
