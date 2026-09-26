# Farboard

Play a friend across the table or across the world.

**[Open Farboard](https://farboard.ehsanr-web.workers.dev/)**
(also at [emrahman.github.io/Farboard](https://emrahman.github.io/Farboard/))

Create an invite, and your opponent scans the QR code or opens the link. You
each play on your own device, wherever you are, with nothing to install and no
account. Moves are end-to-end encrypted.

Playing over a real board instead? [ChessTracker](https://emrahman.github.io/ChessTracker/)
follows a game played with real pieces on one device.

## What it does

- **Invite by QR code or link.** **Create invite** shows both; whoever opens it
  first takes the other seat. Choose to play White, Black or a random colour.
- **Tap a piece to see every legal move.** Quiet moves appear as dots,
  captures as rings. Pins, checks, castling and en passant are all handled, so
  what you see really is what is legal.
- **Tap an opponent piece to preview its moves** in amber — useful for
  checking a threat before you commit. You can only move your own pieces, on
  your turn.
- **Requests the opponent answers**: ask to take back your last move, offer a
  draw, or, once a game is over, ask for a rematch (colours swap). Either side
  can resign.
- **Game events show on the board**: your opponent's move, their requests and
  their answers, so you see them without looking away.
- **Move list** in standard notation (`e4`, `Nf3`, `O-O`, `exd5`, `hxg8=Q+`).
  Step through the game with the arrow buttons, the arrow keys, or by tapping
  any move; new moves keep arriving while you look back.
- **Captured pieces and points.** Each player's strip shows the pieces they
  have taken and their material lead (`+3`), using the usual values —
  pawn 1, knight and bishop 3, rook 5, queen 9.
- **Game end is detected**: checkmate, stalemate, insufficient material,
  threefold repetition and the fifty-move rule.
- **Games survive** reloads, phones going to sleep and patchy networks;
  whatever was missed is caught up on reconnect. Open the page again and you
  are back in your game.
- **Copy PGN or FEN** to keep the game or drop the position into an analysis
  tool afterwards.

## Hosting and your own copy

- Games go through this site's relay, which allows 100 new games a day; the
  home screen shows how many are left.
- **Joining** needs nothing: scan the host's QR code with your phone camera or
  open their link, confirm, and play.
- **Get your own copy** (optional): the whole app, page and relay, on your own free
  Cloudflare account at your own address, with no daily limit for you. Choose
  **Get your own copy** under *Host a game*, copy the owner key the app
  generates, press **Deploy to Cloudflare** (you will need free Cloudflare and
  GitHub accounts), paste the key when asked for `OWNER_KEY`, then paste your
  copy's address and choose **Open**; your key goes with you.

How it is kept private:

- The invite link carries a random 128-bit secret in its `#fragment`, which
  browsers never send to any server. Both devices derive the room id and an
  AES-GCM key from it, so every move is **end-to-end encrypted**: the relay
  passes it along but cannot read or alter it.
- A relay is private unless its owner opens it to everyone (up to a daily
  limit); the owner key is never put in an invite. A game has two seats; once
  both are taken, the link is useless to anyone else.
- Every move from the other device is checked by the rules engine before it is
  shown, and messages that are replayed or reflected back are ignored.
- The relay only serves its own site (and any copies its owner names), keeps
  traffic chess-sized, and deletes games left untouched for a week. On
  Cloudflare's free plan it cannot cost anything; see
  [`relay/README.md`](relay/README.md).
- A relay sees players' IP addresses and when they connect, as any web server
  does, but never their moves.

## Running it

The page itself needs no build step, but playing needs a relay, so run the
whole app as it runs on Cloudflare:

```sh
npm install
cp .dev.vars.example .dev.vars   # then put an OWNER_KEY in it
npm run dev                      # http://localhost:8787
```

Its relay is private, so choose **I'm the owner** under *Host a game* and enter
the key. Open the invite in a private window to play yourself. To try the public
version, run `npx wrangler dev --var PUBLIC_HOSTING:true --var DAILY_GAME_LIMIT:2`.

## How it runs

[`docs/architecture.html`](docs/architecture.html) is a visual guide to the
architecture: which Cloudflare pieces Farboard uses, what one game costs
against the free plan (requests, GB-seconds, SQL rows, storage), and how the
same app would look on AWS or Vercel. Open it in a browser (GitHub shows the
source of HTML files rather than rendering them).

## Publishing

The app is published in two places:

- **[Cloudflare](https://farboard.ehsanr-web.workers.dev/)** (the whole app,
  with online play): one Worker serves the files in `public/` and runs the
  relay. Page files are served free and without limit; only online games use
  the free plan's allowance. The Worker is connected to this repository in the
  Cloudflare dashboard (the Worker → **Settings → Builds**, deploy command
  `npx wrangler deploy`), so every push to `main` redeploys it. Its settings
  (`OWNER_KEY`, `PUBLIC_HOSTING`, `ALLOWED_ORIGINS`) are described in
  [`relay/README.md`](relay/README.md).
- **[GitHub Pages](https://emrahman.github.io/Farboard/)** (a second copy of
  the page): published by the workflow in `.github/workflows` whenever a change
  reaches `main`, after the tests pass. It has no relay of its own, so
  `sharedRelay` in `public/js/config.js` points it at the Cloudflare relay,
  whose `ALLOWED_ORIGINS` includes `https://emrahman.github.io`.

### Your own copy

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/EMRahman/Farboard)

The button copies this repository into your GitHub account and deploys it to
your Cloudflare account. Your copy is private until you choose otherwise; the
app walks you through it under **Get your own copy**.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Step back / forward through the game |
| `Home` / `End` | Jump to the start / the latest move |
| `Ctrl`+`Z` | Ask to take back your last move |
| `F` | Flip the board |
| `Esc` | Clear the current selection |

## Tests

The rules engine is covered by unit tests plus `perft` node counts for the
standard test positions, which is the usual way to prove move generation is
exactly right — castling rights, en passant, promotions and pinned pieces
included.

```sh
npm test
```

The same command runs the online protocol tests (what the app accepts from the
other device), the encryption tests, and the relay's rules.

## Layout

```
public/                     the website, exactly as served
  index.html                markup for the board, panels and dialogs
  css/styles.css            styling and the responsive layout
  js/config.js              the shared relay for copies without their own
  js/chess.js               the rules engine — no DOM, testable on its own
  js/app.js                 board rendering, tap handling, move list
  js/protocol.js            online play: what messages mean and whether to believe them
  js/netcrypto.js           online play: invite secret, room id, encryption
  js/relayclient.js         online play: the connection to the relay, kept alive
  js/online.js              online play: the session, home card, dialogs and invite QR codes
  js/vendor/qrcode.js       QR code encoder (qrcode-generator, MIT)
docs/architecture.html      how it runs, what it costs, and the alternatives
relay/                      the relay: the Worker's code and its Durable Objects
wrangler.jsonc              the Cloudflare Worker: the site plus the relay
test/                       engine, protocol and encryption tests
```

`public/js/chess.js` is self-contained: it knows nothing about the page and can
be reused anywhere. `public/js/app.js` never decides what is legal on its own;
it always asks the engine.
