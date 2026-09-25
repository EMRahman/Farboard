/*
 * Relay rule tests. Run with: npm test (here or at the repository root).
 */
import assert from 'node:assert';
import {
  BUCKET_CAPACITY,
  CLOSE,
  claimGame,
  countRoomMessage,
  currentLedger,
  decideSeat,
  freshBucket,
  hostingLimits,
  isRoomId,
  isSealedFrame,
  isSeatToken,
  leaveSeat,
  nextUtcMidnight,
  originAllowed,
  ownerKeyMatches,
  parseOrigins,
  publicStats,
  takeToken,
  timingSafeEqual
} from '../src/rules.js';

let passed = 0;
let failed = 0;

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

const KEY = 'k'.repeat(43);

console.log('\nrelay rules');

test('room ids must be exactly what the app derives', () => {
  assert.ok(isRoomId('A'.repeat(43)));
  assert.ok(!isRoomId('A'.repeat(42)));
  assert.ok(!isRoomId('A'.repeat(42) + '/'));
  assert.ok(!isRoomId(null));
});

test('only sealed-looking frames are forwarded', () => {
  assert.ok(isSealedFrame('A'.repeat(60)));
  assert.ok(!isSealedFrame('{"t":"peer","online":true}'), 'peers cannot fake relay notices');
  assert.ok(!isSealedFrame('short'));
  assert.ok(!isSealedFrame('A'.repeat(16 * 1024 + 1)));
});

test('seat tokens have a sane shape', () => {
  assert.ok(isSeatToken('abcdefghijklmnopqrstuv'));
  assert.ok(!isSeatToken('short'));
  assert.ok(!isSeatToken('has spaces in it, no good'));
});

test('origins are matched exactly', () => {
  const allowed = parseOrigins(' https://emrahman.github.io/ , http://localhost:8000 ,');
  assert.deepStrictEqual(allowed, ['https://emrahman.github.io', 'http://localhost:8000']);
  assert.ok(originAllowed('https://emrahman.github.io', allowed));
  assert.ok(!originAllowed('https://evil.github.io', allowed));
  assert.ok(!originAllowed('https://emrahman.github.io.evil.com', allowed));
  assert.ok(!originAllowed(null, allowed));
});

test('owner keys are compared exactly', () => {
  assert.ok(ownerKeyMatches(KEY, KEY));
  assert.ok(!ownerKeyMatches(KEY + 'x', KEY));
  assert.ok(!ownerKeyMatches(KEY.slice(1), KEY));
  assert.ok(!ownerKeyMatches(undefined, KEY));
  assert.ok(timingSafeEqual('', ''));
  assert.ok(!timingSafeEqual('a', 'b'));
});

test('a missing or weak owner key opens nothing', () => {
  assert.ok(!ownerKeyMatches(undefined, undefined));
  assert.ok(!ownerKeyMatches('', ''));
  assert.ok(!ownerKeyMatches('short', 'short'));
});

test('only someone allowed to create can make a room', () => {
  assert.deepStrictEqual(decideSeat(null, 'h1', true), { seat: 0, isNew: true });
  assert.strictEqual(decideSeat(null, 'h1', false).reject, CLOSE.ownerKeyRequired);
});

test('the second distinct player gets the second seat', () => {
  assert.deepStrictEqual(decideSeat(['h1'], 'h2', false), { seat: 1, isNew: true });
});

test('known players get their own seats back', () => {
  assert.deepStrictEqual(decideSeat(['h1', 'h2'], 'h1', false), { seat: 0, isNew: false });
  assert.deepStrictEqual(decideSeat(['h1', 'h2'], 'h2', false), { seat: 1, isNew: false });
});

test('a third player is turned away, even with the owner key', () => {
  assert.strictEqual(decideSeat(['h1', 'h2'], 'h3', false).reject, CLOSE.roomFull);
  assert.strictEqual(decideSeat(['h1', 'h2'], 'h3', true).reject, CLOSE.roomFull);
});

test('a player who left cannot take their seat back', () => {
  assert.strictEqual(decideSeat(['h1', 'h2'], 'h2', false, [1]).reject, CLOSE.left);
  assert.deepStrictEqual(decideSeat(['h1', 'h2'], 'h1', false, [1]), { seat: 0, isNew: false });
});

test('a game both players have left stays closed to everyone', () => {
  assert.strictEqual(decideSeat(['h1', 'h2'], 'h1', true, [0, 1]).reject, CLOSE.ended);
  assert.strictEqual(decideSeat(['h1', 'h2'], 'h3', true, [0, 1]).reject, CLOSE.ended);
});

test('leaving is recorded once, and the room is done when both have left', () => {
  assert.deepStrictEqual(leaveSeat([], 1), { left: [1], everyone: false });
  assert.deepStrictEqual(leaveSeat([1], 1), { left: [1], everyone: false });
  assert.deepStrictEqual(leaveSeat([1], 0), { left: [0, 1], everyone: true });
});

test('the rate limit allows a burst, then refills over time', () => {
  let bucket = freshBucket(0);
  for (let i = 0; i < BUCKET_CAPACITY; i++) {
    bucket = takeToken(bucket, 0);
    assert.ok(bucket, 'message ' + i);
  }
  assert.strictEqual(takeToken(bucket, 0), null);
  assert.ok(takeToken(bucket, 1000), 'a second later there is room again');
});

test('the bucket never fills past capacity', () => {
  const later = takeToken(freshBucket(0), 10 * 60 * 1000);
  assert.strictEqual(later.tokens, BUCKET_CAPACITY - 1);
});

console.log('\npublic hosting');

const T0 = Date.UTC(2026, 8, 25, 10, 30); // 2026-09-25 10:30 UTC
const LIMITS = { public: true, daily: 3, hourlyPerNetwork: 2 };

test('public hosting is off unless switched on, with sensible defaults', () => {
  assert.deepStrictEqual(hostingLimits({}), { public: false, daily: 100, hourlyPerNetwork: 10 });
  assert.deepStrictEqual(
    hostingLimits({ PUBLIC_HOSTING: 'true', DAILY_GAME_LIMIT: '100', HOURLY_GAMES_PER_NETWORK: '5' }),
    { public: true, daily: 100, hourlyPerNetwork: 5 }
  );
  assert.strictEqual(hostingLimits({ PUBLIC_HOSTING: 'no' }).public, false);
  assert.strictEqual(hostingLimits({ DAILY_GAME_LIMIT: 'lots' }).daily, 100);
  assert.strictEqual(hostingLimits({ DAILY_GAME_LIMIT: '0' }).daily, 0, 'zero pauses public hosting');
});

test('games are counted until the daily cap, then refused', () => {
  let ledger = null;
  for (let i = 0; i < 3; i++) {
    const r = claimGame(ledger, T0, 'net-' + i, LIMITS, false);
    assert.ok(r.ok, 'game ' + (i + 1));
    ledger = r.ledger;
  }
  const refused = claimGame(ledger, T0, 'net-9', LIMITS, false);
  assert.ok(!refused.ok);
  assert.strictEqual(refused.reason, 'daily');
  assert.strictEqual(refused.ledger.games, 3, 'a refusal is not counted');
});

test('one network cannot use the whole day', () => {
  let ledger = claimGame(null, T0, 'net', LIMITS, false).ledger;
  ledger = claimGame(ledger, T0, 'net', LIMITS, false).ledger;
  const third = claimGame(ledger, T0, 'net', LIMITS, false);
  assert.ok(!third.ok);
  assert.strictEqual(third.reason, 'network');
  assert.ok(claimGame(ledger, T0 + 60 * 60 * 1000, 'net', LIMITS, false).ok, 'allowed again next hour');
});

test('the owner is counted but never refused', () => {
  let ledger = null;
  for (let i = 0; i < 5; i++) {
    const r = claimGame(ledger, T0, 'owner-net', LIMITS, true);
    assert.ok(r.ok);
    ledger = r.ledger;
  }
  assert.strictEqual(ledger.games, 5);
  assert.ok(!claimGame(ledger, T0, 'other', LIMITS, false).ok, 'the owner\'s games use up the day too');
});

test('the count resets at midnight UTC', () => {
  let ledger = null;
  for (let i = 0; i < 3; i++) ledger = claimGame(ledger, T0, 'n' + i, LIMITS, false).ledger;
  const tomorrow = nextUtcMidnight(T0);
  assert.strictEqual(new Date(tomorrow).toISOString(), '2026-09-26T00:00:00.000Z');
  assert.ok(!claimGame(ledger, tomorrow - 1, 'x', LIMITS, false).ok);
  assert.ok(claimGame(ledger, tomorrow, 'x', LIMITS, false).ok);
  assert.strictEqual(currentLedger(ledger, tomorrow).games, 0);
});

test('stats report the day without naming networks', () => {
  const ledger = claimGame(null, T0, 'secret-hash', LIMITS, false).ledger;
  const stats = publicStats(ledger, T0, LIMITS);
  assert.deepStrictEqual(stats, {
    publicHosting: true,
    dailyLimit: 3,
    gamesToday: 1,
    remaining: 2,
    resetsAt: '2026-09-26T00:00:00.000Z'
  });
  assert.ok(!JSON.stringify(stats).includes('secret-hash'));
});

test('a room\'s daily message allowance runs out, then resets', () => {
  let usage = null;
  for (let i = 0; i < 5; i++) {
    const r = countRoomMessage(usage, T0, 5);
    assert.ok(r.ok, 'message ' + (i + 1));
    usage = r.usage;
  }
  assert.ok(!countRoomMessage(usage, T0, 5).ok);
  assert.ok(countRoomMessage(usage, nextUtcMidnight(T0), 5).ok);
});

console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
