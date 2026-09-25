/*
 * room.js — one Durable Object per game.
 *
 * The room hands out two seats and passes sealed frames from one seat to the
 * other. It cannot read them: the key never leaves the players' devices. It
 * uses the WebSocket Hibernation API, so a game where nobody is moving costs
 * nothing.
 *
 * Every frame, keep-alive pings included, goes through the same per-socket
 * rate limit and the room's daily message allowance, so no connection can
 * spend the relay's daily requests faster than a game of chess would.
 *
 * Stored per room: the hashes of the two seat tokens, when it was made, which
 * seats have left for good, and today's message count. Nothing about the
 * game itself; the devices hold that.
 */
import { DurableObject } from 'cloudflare:workers';
import {
  CLOSE,
  MAX_FRAME,
  MAX_SOCKETS,
  PROTO,
  ROOM_IDLE_MS,
  countRoomMessage,
  decideSeat,
  freshBucket,
  hostingLimits,
  isSealedFrame,
  isSeatToken,
  leaveSeat,
  ownerKeyMatches,
  takeToken,
  utcDay
} from './rules.js';

const OPEN = 1;
const HOUR = 60 * 60 * 1000;
const JOIN_GRACE_MS = 10 * 1000;
const USAGE_SAVE_EVERY = 50;

export class Room extends DurableObject {
  async fetch(request) {
    const now = Date.now();
    this.dropStragglers(now);
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return new Response('Too many connections to this game', { status: 429 });
    }
    // Hashed with the day so it only means anything for today's counting.
    const network = await sha256(utcDay(now) + '|' + (request.headers.get('CF-Connecting-IP') || ''));
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ seat: null, bucket: freshBucket(now), opened: now, network });
    return new Response(null, { status: 101, webSocket: client });
  }

  /* Connections that never said who they are should not hold slots. */
  dropStragglers(now) {
    for (const ws of this.ctx.getWebSockets()) {
      const state = ws.deserializeAttachment();
      if (state && state.seat === null && now - state.opened > JOIN_GRACE_MS) {
        closeSocket(ws, CLOSE.badRequest, 'expected join');
      }
    }
  }

  async webSocketMessage(ws, message) {
    const now = Date.now();
    const state = ws.deserializeAttachment() || { seat: null, bucket: freshBucket(now) };

    const bucket = takeToken(state.bucket, now);
    if (!bucket) return closeSocket(ws, CLOSE.tooFast, 'too many messages');
    state.bucket = bucket;

    if (typeof message !== 'string' || message.length > MAX_FRAME) {
      return closeSocket(ws, CLOSE.tooBig, 'frame too large');
    }

    if (state.seat === null) return this.join(ws, state, message, now);
    ws.serializeAttachment(state);

    // Leaving must always be recorded, even in a room past its daily cap:
    // the leaver forgets the game straight after sending it.
    if (message.charAt(0) === '{') return this.leave(ws, state, message, now);

    if (!(await this.countMessage(now))) {
      for (const socket of this.ctx.getWebSockets()) {
        closeSocket(socket, CLOSE.roomLimit, 'daily message allowance used');
      }
      return;
    }

    if (message === 'ping') {
      sendText(ws, 'pong');
      return;
    }
    if (!isSealedFrame(message)) return closeSocket(ws, CLOSE.badRequest, 'unexpected frame');
    const peer = this.seatSocket(1 - state.seat, ws);
    if (peer) peer.send(message);
    await this.keepAlive(now);
  }

  /*
   * The first frame on a connection: { t: 'join', seatToken, create?, ownerKey? }.
   * Only the host's app sends `create`, so a guest who arrives after a game
   * has expired is told so instead of quietly opening an empty new room.
   */
  async join(ws, state, message, now) {
    let hello = null;
    try {
      hello = JSON.parse(message);
    } catch (err) {
      /* handled below */
    }
    if (!hello || hello.t !== 'join' || !isSeatToken(hello.seatToken)) {
      return closeSocket(ws, CLOSE.badRequest, 'expected join');
    }

    const tokenHash = await sha256(hello.seatToken);
    const ownerOk = ownerKeyMatches(hello.ownerKey, this.env.OWNER_KEY);
    const limits = hostingLimits(this.env);

    // One join at a time, start to finish: creating a room asks the budget
    // (another object), and nothing else may slip in while that happens.
    const decision = await this.ctx.blockConcurrencyWhile(async () => {
      const meta = (await this.ctx.storage.get('meta')) || null;
      const canCreate = hello.create === true && (ownerOk || limits.public);
      const choice = decideSeat(meta ? meta.seats : null, tokenHash, canCreate, meta ? meta.left || [] : []);
      if (choice.reject) return choice;

      if (!meta && limits.public) {
        const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName('budget'));
        const claim = await budget.claim(state.network, limits, ownerOk);
        if (!claim.ok) {
          return claim.reason === 'network'
            ? { reject: CLOSE.networkLimit, reason: 'too many new games from your network' }
            : { reject: CLOSE.dailyLimit, reason: 'daily game limit reached' };
        }
      }

      if (choice.isNew) {
        await this.ctx.storage.put('meta', {
          seats: meta ? meta.seats.concat(tokenHash) : [tokenHash],
          created: meta ? meta.created : now,
          left: meta ? meta.left || [] : []
        });
      }
      // Tell a returning player if the other one left while they were away.
      return { ...choice, peerLeft: !!meta && (meta.left || []).includes(1 - choice.seat) };
    });
    if (decision.reject) return closeSocket(ws, decision.reject, decision.reason);

    // An older connection for the same seat (a reload, a second tab) gives way.
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws && seatOf(other) === decision.seat) {
        closeSocket(other, CLOSE.replaced, 'opened elsewhere');
      }
    }

    state.seat = decision.seat;
    ws.serializeAttachment(state);

    const peer = this.seatSocket(1 - decision.seat, ws);
    sendText(
      ws,
      JSON.stringify({ t: 'joined', proto: PROTO, seat: decision.seat, peer: !!peer, peerLeft: decision.peerLeft })
    );
    if (peer) sendText(peer, JSON.stringify({ t: 'peer', online: true }));
    await this.keepAlive(now);
  }

  /* Today's message count for the room, saved every so often. */
  async countMessage(now) {
    if (!this.usage) this.usage = (await this.ctx.storage.get('usage')) || null;
    const counted = countRoomMessage(this.usage, now);
    this.usage = counted.usage;
    if (counted.usage.n % USAGE_SAVE_EVERY === 0) this.ctx.storage.put('usage', counted.usage);
    return counted.ok;
  }

  /*
   * { t: 'leave' }: this player is done with the game for good. Their seat is
   * closed to them, the other player is told (now, or when they next
   * connect), and once both have left the game is closed to everyone until
   * the room's usual clean-up a week later.
   */
  async leave(ws, state, message, now) {
    let note = null;
    try {
      note = JSON.parse(message);
    } catch (err) {
      /* handled below */
    }
    if (!note || note.t !== 'leave') return closeSocket(ws, CLOSE.badRequest, 'unexpected frame');

    await this.ctx.blockConcurrencyWhile(async () => {
      const meta = (await this.ctx.storage.get('meta')) || null;
      if (!meta) return;
      const { left, everyone } = leaveSeat(meta.left || [], state.seat);
      await this.ctx.storage.put('meta', { ...meta, left });
      // A finished game keeps this small record until the usual clean-up, so a
      // stale tab cannot bring the room back to life by creating it afresh.
      if (everyone) await this.ctx.storage.setAlarm(now + ROOM_IDLE_MS);
    });

    const peer = this.seatSocket(1 - state.seat, ws);
    if (peer) sendText(peer, JSON.stringify({ t: 'peer', online: false, left: true }));
    state.left = true;
    ws.serializeAttachment(state);
    closeSocket(ws, 1000, 'left the game');
  }

  async webSocketClose(ws) {
    this.left(ws);
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const seat = seatOf(ws);
    if (seat === null || ws.deserializeAttachment().left) return; // already announced
    // If a newer connection already holds this seat, nobody has really left.
    if (this.seatSocket(seat, ws)) return;
    const peer = this.seatSocket(1 - seat, ws);
    if (peer) sendText(peer, JSON.stringify({ t: 'peer', online: false }));
  }

  seatSocket(seat, except) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws !== except && ws.readyState === OPEN && seatOf(ws) === seat) return ws;
    }
    return null;
  }

  /* Push the expiry back; only write when it has drifted by an hour or more. */
  async keepAlive(now) {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current - now < ROOM_IDLE_MS - HOUR) {
      await this.ctx.storage.setAlarm(now + ROOM_IDLE_MS);
    }
  }

  /* Nobody has said anything for a week: forget the room. */
  async alarm() {
    for (const ws of this.ctx.getWebSockets()) closeSocket(ws, CLOSE.expired, 'game expired');
    await this.ctx.storage.deleteAll();
  }
}

function seatOf(ws) {
  const state = ws.deserializeAttachment();
  return state && typeof state.seat === 'number' ? state.seat : null;
}

function sendText(ws, text) {
  try {
    ws.send(text);
  } catch (err) {
    /* the socket is already going away */
  }
}

function closeSocket(ws, code, reason) {
  try {
    ws.close(code, reason);
  } catch (err) {
    /* already closed */
  }
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}
