# Farboard

Play on your real board, or with a friend far away.

**[Open Farboard](https://farboard.ehsanr-web.workers.dev/)**
(also at [emrahman.github.io/Farboard](https://emrahman.github.io/Farboard/))

Playing over the board means holding the whole position in your head: which
piece is where, what each one can reach, what you have already given up.
Farboard takes that load off. You play your move on the physical board,
tap the same move here, and the screen shows you the position, every legal
move for whatever piece you tap, and the running material count.

It is not an engine and it will not suggest moves. It is a mirror of your
board that knows the rules.

When your opponent is not in the room, send them a link or show them a QR
code: you each play on your own device, anywhere, with nothing to install and
no account. See [Play online](#play-online).

## What it does

- **Digital board** with the pieces drawn as clear symbols, in the familiar
  green-and-cream style.
- **Tap a piece to see every legal move.** Quiet moves appear as dots,
  captures as rings. Pins, checks, castling and en passant are all handled, so
  what you see really is what is legal.
- **Tap an opponent piece to preview its moves** in amber, without playing
  anything — useful for checking a threat before you commit.
- **Move recording** in standard notation (`e4`, `Nf3`, `O-O`, `exd5`,
  `hxg8=Q+`), numbered the way a scoresheet is.
- **Turns switch automatically**; the strip belonging to the side to move is
  outlined. Turn on *auto-flip* and the board rotates to face whoever is
  moving, which suits two people sharing one phone.
- **Take back a mistake** with the take-back button or `Ctrl`+`Z`. Step
  through the game with the arrow buttons, the arrow keys, or by tapping any
  move in the list.
- **Captured pieces and points.** Each player's strip shows the pieces they
  have taken and their material lead (`+3`), using the usual values —
  pawn 1, knight and bishop 3, rook 5, queen 9.
- **Game end is detected**: checkmate, stalemate, insufficient material,
  threefold repetition and the fifty-move rule.
- **Your game is saved in the browser.** Close the tab, come back, and the
  game is where you left it.
- **Copy PGN or FEN** to keep the game or drop the position into an analysis
  tool afterwards.

## Play online

Besides the one-device board, you can play someone on another device, anywhere.
The one-device board stays the default and is untouched: it never contacts
anything unless you choose **Play online**.

- **Hosting**: **Play online → Create invite** shows a QR code and a link.
  Games go through this site's relay, which allows 100 new games a day; the
  menu shows how many are left.
- **Joining** needs nothing: scan the host's QR code with your phone camera or
  open their link, confirm, and play. No account, no install.
- **Your own copy** (optional): the whole app, page and relay, on your own free
  Cloudflare account at your own address, with no daily limit for you. Under
  **Play online → Your own copy**, copy the owner key the app generates, press
  **Deploy to Cloudflare** (you will need free Cloudflare and GitHub accounts),
  paste the key when asked for `OWNER_KEY`, then paste your copy's address and
  choose **Open**; your key goes with you.
- Each device plays its own colour and can only move on its turn. Take-backs,
  draws and new games are requests the opponent accepts or declines; colours
  swap for each new game. Either side can resign.
- Games survive reloads, phones going to sleep and patchy networks; whatever
  was missed is caught up on reconnect. **Local board** returns to your
  one-device game exactly as you left it, and the online game can be resumed
  from **Play online**.

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

The one-device board needs no build step and no dependencies: open
`public/index.html` in a browser (double-clicking the file works), or serve the
folder with `npm start` and visit http://localhost:8000.

For online play too, run the whole app as it runs on Cloudflare:

```sh
npm install
cp .dev.vars.example .dev.vars   # then put an OWNER_KEY in it
npm run dev                      # http://localhost:8787
```

Its relay is private, so choose **Play online → I'm the owner** and enter the
key. Open the invite in a private window to play yourself. To try the public
version, run `npx wrangler dev --var PUBLIC_HOSTING:true --var DAILY_GAME_LIMIT:2`.

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
app walks you through it under **Play online → Your own copy**.

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `←` / `→` | Step back / forward through the game |
| `Home` / `End` | Jump to the start / the latest move |
| `Ctrl`+`Z` | Take back the last move |
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
  js/app.js                 board rendering, tap handling, move list, storage
  js/protocol.js            online play: what messages mean and whether to believe them
  js/netcrypto.js           online play: invite secret, room id, encryption
  js/relayclient.js         online play: the connection to the relay, kept alive
  js/online.js              online play: the session, dialogs and invite QR codes
  js/vendor/qrcode.js       QR code encoder (qrcode-generator, MIT)
relay/                      the relay: the Worker's code and its Durable Objects
wrangler.jsonc              the Cloudflare Worker: the site plus the relay
test/                       engine, protocol and encryption tests
```

`public/js/chess.js` is self-contained: it knows nothing about the page and can
be reused anywhere. `public/js/app.js` never decides what is legal on its own;
it always asks the engine.
