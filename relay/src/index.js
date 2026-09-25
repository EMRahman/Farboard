/*
 * Farboard relay — the Worker in front of the game rooms.
 *
 * The same Worker serves the website: Cloudflare answers requests for the
 * files in public/ directly, and only requests that match no file (these
 * routes) run this code.
 *
 *   GET  /v1/info           what this is, and whether it is set up
 *   GET  /v1/stats          public hosting: games started today, and the cap
 *   POST /v1/verify         { key } → 204 if it is this relay's owner key
 *   GET  /v1/rooms/:roomId  WebSocket into that game's room
 *
 * Settings (Cloudflare dashboard → the Worker → Settings → Variables):
 *   OWNER_KEY        secret; starts games on a private relay, skips the cap
 *                    on a public one; never needed to join a game
 *   ALLOWED_ORIGINS  other web addresses the app is served from, comma
 *                    separated (its own address is always allowed)
 *
 * Public hosting (off unless set; lets anyone start games, within limits):
 *   PUBLIC_HOSTING            'true' to switch it on
 *   DAILY_GAME_LIMIT          new games per UTC day (default 100)
 *   HOURLY_GAMES_PER_NETWORK  new games per network per hour (default 10)
 */
import {
  PROTO,
  hostingLimits,
  isRoomId,
  originAllowed,
  ownerKeyMatches,
  ownerKeyUsable,
  parseOrigins
} from './rules.js';

export { Room } from './room.js';
export { Budget } from './budget.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    // The site this Worker serves, plus any other copies named in the settings.
    const allowed = [url.origin, ...parseOrigins(env.ALLOWED_ORIGINS)];

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    // HTTP answers carry no cookies or secrets of their own, so any page may
    // read them; that lets the app say exactly what is wrong during setup.
    if (url.pathname === '/v1/info' && request.method === 'GET') {
      return json({
        app: 'farboard-relay',
        proto: PROTO,
        ownerKeySet: ownerKeyUsable(env.OWNER_KEY),
        // Browsers leave Origin off same-site GETs, so no Origin means this site.
        originAllowed: !origin || originAllowed(origin, allowed),
        publicHosting: hostingLimits(env).public
      });
    }

    if (url.pathname === '/v1/stats' && request.method === 'GET') {
      const limits = hostingLimits(env);
      if (!limits.public) return json({ publicHosting: false });
      const budget = env.BUDGET.get(env.BUDGET.idFromName('budget'));
      return json(await budget.stats(limits));
    }

    if (url.pathname === '/v1/verify' && request.method === 'POST') {
      if (!originAllowed(origin, allowed)) return json({ error: 'origin not allowed' }, 403);
      let body = null;
      try {
        body = await request.json();
      } catch (err) {
        return json({ error: 'expected JSON' }, 400);
      }
      const ok = !!body && ownerKeyMatches(body.key, env.OWNER_KEY);
      return new Response(null, { status: ok ? 204 : 401, headers: CORS });
    }

    const room = url.pathname.match(/^\/v1\/rooms\/([^/]+)$/);
    if (room) {
      if (request.headers.get('Upgrade') !== 'websocket') return text('Expected a WebSocket', 426);
      // Browsers always send the page's origin with a WebSocket and pages cannot
      // change it, so this keeps other websites from using the relay.
      if (!originAllowed(origin, allowed)) return text('Origin not allowed', 403);
      if (!isRoomId(room[1])) return text('Bad room id', 400);
      const stub = env.ROOM.get(env.ROOM.idFromName(room[1]));
      return stub.fetch(request);
    }

    return text('Not found', 404);
  }
};

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' }
  });
}

function text(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...CORS, 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
