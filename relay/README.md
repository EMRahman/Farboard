# Farboard relay

The part of Farboard that lets two devices play each other. It runs in the
same Cloudflare Worker that serves the website (see `wrangler.jsonc` at the
top of the repository), on the free plan. It passes moves between players and
cannot read them.

A relay is **private** by default: only its owner can start games, and anyone
they invite can join. Its owner can instead switch on **public hosting**, so
anyone using the site can start games, up to a daily limit.

## Settings

Set these in the Cloudflare dashboard under the Worker → **Settings →
Variables and Secrets**. They take effect straight away, with no redeploy, and
redeploys keep them (`keep_vars`). None of them is in `wrangler.jsonc`, so
every copy starts out private.

| Name | Kind | What it is |
| --- | --- | --- |
| `OWNER_KEY` | secret | Starts games on a private relay, and skips the daily limit on a public one. Never needed to join a game. At least 16 characters. |
| `PUBLIC_HOSTING` | variable | `true` lets anyone start games, within the limits below. Off unless set. |
| `DAILY_GAME_LIMIT` | variable | With public hosting, new games per UTC day. Default `100`; `0` pauses new games. |
| `HOURLY_GAMES_PER_NETWORK` | variable | With public hosting, new games one network may start per hour. Default `10`. |
| `ALLOWED_ORIGINS` | variable | Other web addresses allowed to use this relay, comma-separated, such as a GitHub Pages copy of the site. The Worker's own address is always allowed. |

## Deploying

**A copy of your own**: press the button. It copies the repository into your
GitHub account, deploys it to your Cloudflare account, and asks for
`OWNER_KEY`; Farboard's **Play online → Your own copy** generates one for
you and walks you through the rest.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/EMRahman/Farboard)

The copy is a snapshot: later changes to this repository do not reach it.
Press the button again, or copy the changes over, to update.

**The repository's own deployment** is connected to this repository instead
(Cloudflare dashboard → **Workers & Pages → Create → Import a repository**,
deploy command `npx wrangler deploy`), so every push to `main` redeploys it.

**From the command line**: `npx wrangler deploy`, then
`npx wrangler secret put OWNER_KEY`.

## Public hosting

1. Set `PUBLIC_HOSTING` to `true`, and `DAILY_GAME_LIMIT` if you want something
   other than 100.
2. On the site, choose **Play online → I'm the owner** and enter the owner
   key. Games you start are then never turned away, though they still count.

What the limit does:

- It counts **new games (invites)**, not moves or rematches. **New game**
  inside an existing game is not counted.
- When it is reached, **Create invite** is disabled and says when it reopens
  (midnight UTC). **Games already under way carry on**: joining, reconnecting
  and moving are never refused because of it.
- A guest arriving at a game that has expired is told so; they cannot open a
  new room by accident, and nothing is counted.

### Watching the limit being reached

- `GET https://<your-copy>/v1/stats` returns
  `{ publicHosting, dailyLimit, gamesToday, remaining, resetsAt }`. Nothing in
  it identifies anyone.
- Workers Logs (the Worker → **Logs**) shows one line per attempt:
  `{"event":"game-created","gamesToday":37,"dailyLimit":100}`, or
  `"game-refused"` with `"reason":"daily"` or `"network"`.
- To see a refusal for yourself, set `DAILY_GAME_LIMIT` to `2`, start two games
  from a browser where you have not entered the owner key, then try a third.
  Set it back afterwards.
- The Worker's **Metrics** tab and the Durable Objects page show requests
  against the free plan's 100,000 a day. Requests for the page itself are free
  and not counted.

Per game, expect roughly 8 Worker requests and 10–20 Durable Object requests
(connections, moves, syncs and pings), so 100 games a day uses about 2% of the
free allowance.

## What it does and does not do

- **One Durable Object per game**, with two seats. Opening a game needs the
  owner key, or public hosting within its limit; the invite link fills the
  second seat; after that the game is closed to anyone else. Each device keeps
  a seat token, so it can reconnect after a reload or a phone going to sleep.
- **Passes sealed frames along without reading them.** The encryption key comes
  from the invite secret, which travels in the link's `#fragment` and never
  reaches any server. The relay stores only the two seat-token hashes, the
  room's creation time and its message count for the day.
- **Chess-sized limits**: frames up to 16 KB, about 3 messages a second per
  connection, 5,000 messages per room per day, six connections per room at
  most. Keep-alive pings count too, so nothing can spend the day's requests
  faster than games of chess would. A room nobody has spoken in for a week is
  deleted.
- **Hibernates between moves**, so an idle game uses nothing, and the app only
  pings while its page is on screen. If a day's free allowance ever runs out,
  online play stops until midnight UTC (the page itself keeps working); the
  free plan never bills you.
- **What it sees**: players' IP addresses and when they connect (as any web
  server does), never their moves. For public hosting it keeps a count of new
  games per network for the current hour, keyed by a hash of the day and the
  address.

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /v1/info` | `{ app, proto, ownerKeySet, originAllowed, publicHosting }`, used by the app to find its relay |
| `GET /v1/stats` | With public hosting: `{ publicHosting, dailyLimit, gamesToday, remaining, resetsAt }` |
| `POST /v1/verify` | `{ key }` → `204` if it is the owner key, `401` if not |
| `GET /v1/rooms/:roomId` | WebSocket into a game room |

Everything else is the website, served from `public/`.

## Developing

From the top of the repository:

```sh
npm install
cp .dev.vars.example .dev.vars   # then put an OWNER_KEY in it
npm run dev                      # site and relay at http://localhost:8787
npx wrangler dev --var PUBLIC_HOSTING:true --var DAILY_GAME_LIMIT:3   # as a public relay
npm test                         # includes this folder's rule tests
```
