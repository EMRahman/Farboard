/*
 * rules.js — the relay's decisions, kept free of Cloudflare APIs so they can
 * be tested in plain Node.
 *
 * The relay is deliberately only good for chess: two seats per room, small
 * text frames, a human pace of messages. That makes it useless to anyone
 * hoping for a free general-purpose relay, even if they find its address.
 */

export const PROTO = 1;

/* Longer than the full move list of any real game, once sealed. */
export const MAX_FRAME = 16 * 1024;

/* Messages one room may pass in a UTC day: several long games' worth. */
export const ROOM_DAILY_MESSAGES = 5000;

/* Public hosting defaults, when the relay's settings do not say otherwise. */
export const DEFAULT_DAILY_GAME_LIMIT = 100;
export const DEFAULT_HOURLY_GAMES_PER_NETWORK = 10;

/* Rooms nobody has spoken in for this long are deleted. */
export const ROOM_IDLE_MS = 7 * 24 * 60 * 60 * 1000;

/* Two seats, plus room for a reload or second tab to overlap briefly. */
export const MAX_SOCKETS = 6;

/* Token bucket: bursts of up to 30 messages, refilled at 3 a second. */
export const BUCKET_CAPACITY = 30;
export const BUCKET_REFILL_PER_MS = 3 / 1000;

export const CLOSE = {
  badRequest: 4400,
  ownerKeyRequired: 4401,
  roomFull: 4403,
  replaced: 4409,
  expired: 4410,
  left: 4411,
  ended: 4412,
  tooFast: 4429,
  networkLimit: 4430,
  roomLimit: 4508,
  dailyLimit: 4503,
  tooBig: 1009
};

/* 32 bytes of HKDF output, base64url: all a room id can be. */
export function isRoomId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

/* After joining, the only frames worth forwarding are sealed ones. */
export function isSealedFrame(value) {
  return (
    typeof value === 'string' &&
    value.length >= 38 &&
    value.length <= MAX_FRAME &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

export function isSeatToken(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

export function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter(Boolean);
}

export function originAllowed(origin, allowed) {
  return typeof origin === 'string' && allowed.includes(origin);
}

/* An owner key too short to resist guessing is treated as not set at all. */
export function ownerKeyUsable(key) {
  return typeof key === 'string' && key.length >= 16;
}

/* Compare without leaking, through timing, how much of the key matched. */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const length = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < length; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export function ownerKeyMatches(offered, configured) {
  return ownerKeyUsable(configured) && timingSafeEqual(offered, configured);
}

/*
 * Who gets which seat. `seats` is the list of seat-token hashes the room has
 * handed out, or null if the room does not exist yet.
 *
 *   - Only someone allowed to create games can bring a room into existence:
 *     the relay's owner, or anyone when public hosting is on.
 *   - Once both players have left, the game is over for everyone.
 *   - A known token gets its old seat back (a reconnect or a reload),
 *     unless that player has left the game for good.
 *   - A new token gets the next free seat; there are two.
 */
export function decideSeat(seats, tokenHash, canCreate, left = []) {
  if (seats === null) {
    if (!canCreate) return { reject: CLOSE.ownerKeyRequired, reason: 'no such game' };
    return { seat: 0, isNew: true };
  }
  if (left.length >= 2) return { reject: CLOSE.ended, reason: 'game has ended' };
  const known = seats.indexOf(tokenHash);
  if (known !== -1 && left.includes(known)) return { reject: CLOSE.left, reason: 'you left this game' };
  if (known !== -1) return { seat: known, isNew: false };
  if (seats.length < 2) return { seat: seats.length, isNew: true };
  return { reject: CLOSE.roomFull, reason: 'game is full' };
}

/*
 * Record that a seat has left the game for good. Returns the new list of
 * seats that have left, and whether that is now everyone.
 */
export function leaveSeat(left, seat) {
  const next = left.includes(seat) ? left.slice() : left.concat(seat).sort();
  return { left: next, everyone: next.length >= 2 };
}

export function freshBucket(now) {
  return { tokens: BUCKET_CAPACITY, at: now };
}

/* Spend one token. Returns the updated bucket, or null if it was empty. */
export function takeToken(bucket, now) {
  const elapsed = Math.max(0, now - bucket.at);
  const tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + elapsed * BUCKET_REFILL_PER_MS);
  if (tokens < 1) return null;
  return { tokens: tokens - 1, at: now };
}

/* ------------------------------------------------------- public hosting */

export function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcHour(now) {
  return new Date(now).toISOString().slice(0, 13);
}

export function nextUtcMidnight(now) {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}

export function flagOn(value) {
  return /^(1|true|yes|on)$/i.test(String(value || '').trim());
}

export function positiveInt(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/* The relay's hosting settings, read from its environment. */
export function hostingLimits(env) {
  return {
    public: flagOn(env.PUBLIC_HOSTING),
    daily: positiveInt(env.DAILY_GAME_LIMIT, DEFAULT_DAILY_GAME_LIMIT),
    hourlyPerNetwork: positiveInt(env.HOURLY_GAMES_PER_NETWORK, DEFAULT_HOURLY_GAMES_PER_NETWORK)
  };
}

/*
 * The budget ledger: games created today, and per network this hour.
 *   { day, games, hour, networks: { [hash]: count } }
 * Old days and hours are dropped as time moves on.
 */
export function freshLedger(now) {
  return { day: utcDay(now), games: 0, hour: utcHour(now), networks: {} };
}

export function currentLedger(ledger, now) {
  let next = ledger ? { ...ledger, networks: { ...ledger.networks } } : freshLedger(now);
  if (next.day !== utcDay(now)) next = { ...next, day: utcDay(now), games: 0 };
  if (next.hour !== utcHour(now)) next = { ...next, hour: utcHour(now), networks: {} };
  return next;
}

/*
 * Ask to create one game. The owner is always allowed (and counted, so the
 * numbers show everything); anyone else only while today's allowance and
 * their network's hourly allowance last.
 *
 * Returns { ok, ledger, reason? } — reason is 'daily' or 'network'.
 */
export function claimGame(ledger, now, networkHash, limits, isOwner) {
  const next = currentLedger(ledger, now);
  const fromNetwork = next.networks[networkHash] || 0;
  if (!isOwner) {
    if (next.games >= limits.daily) return { ok: false, ledger: next, reason: 'daily' };
    if (fromNetwork >= limits.hourlyPerNetwork) return { ok: false, ledger: next, reason: 'network' };
  }
  next.games += 1;
  next.networks[networkHash] = fromNetwork + 1;
  return { ok: true, ledger: next };
}

/* What /v1/stats reports; nothing in it identifies anyone. */
export function publicStats(ledger, now, limits) {
  const current = currentLedger(ledger, now);
  return {
    publicHosting: limits.public,
    dailyLimit: limits.daily,
    gamesToday: current.games,
    remaining: Math.max(0, limits.daily - current.games),
    resetsAt: new Date(nextUtcMidnight(now)).toISOString()
  };
}

/*
 * Count one message against a room's daily allowance.
 *   usage: { day, n }
 * Returns { usage, ok }.
 */
export function countRoomMessage(usage, now, limit = ROOM_DAILY_MESSAGES) {
  const day = utcDay(now);
  const next = usage && usage.day === day ? { day, n: usage.n + 1 } : { day, n: 1 };
  return { usage: next, ok: next.n <= limit };
}
