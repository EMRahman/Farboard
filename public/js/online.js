/*
 * online.js — playing someone on another device, through your own relay.
 *
 * Nothing here runs unless asked. The page loads as the ordinary one-device
 * board; this file only looks at the address bar for an invite or a setup
 * link, and otherwise waits for the Play online button.
 *
 * Who does what:
 *   online.js     the online session (who we are, the shared game state),
 *                 the dialogs, and the conversation with the other device
 *   protocol.js   what each message means and whether to believe it
 *   netcrypto.js  the invite secret, room id and message encryption
 *   relayclient   the WebSocket to the relay, kept alive
 *   app.js        the board, driven through window.Farboard
 *
 * Where games are hosted. Every copy of Farboard on Cloudflare has its
 * own relay at the same address (the "house" relay); a copy without one, like
 * the GitHub Pages site, uses the shared relay named in config.js. The house
 * relay is either public (anyone may host, up to a daily limit) or private
 * (only its owner). A verified owner key goes first: it hosts on that relay
 * without limits. Guests always use whichever relay the invite names.
 *
 * Saved in this browser:
 *   farboard:relay:v1   { url, key, verified }  an owner key that works
 *   farboard:draft:v1   the key made up for a copy not yet deployed
 *   farboard:online:v1  the online game in progress, if any
 */
(function () {
  'use strict';

  var P = window.ChessProtocol;
  var C = window.NetCrypto;
  var RelayClient = window.RelayClient;

  var SESSION_KEY = 'farboard:online:v1';
  var RELAY_KEY = 'farboard:relay:v1';
  var DRAFT_KEY = 'farboard:draft:v1';

  var CONFIG = window.FarboardConfig || {};
  var SHARED_RELAY = P.normalizeRelay(CONFIG.sharedRelay);
  var DEPLOY_URL = CONFIG.deployUrl || '';

  var TITLES = {
    menu: 'Play online',
    copy: 'Get your own copy',
    owner: 'Owner key',
    invite: 'Invite your opponent',
    join: 'Join a game'
  };

  var COLOR_NAMES = { w: 'White', b: 'Black' };

  var app; // window.Farboard
  var el = {};
  var baseTitle = document.title;

  /*
   * session: { v, relay, secret, role, seatToken, sendN, lastSeen, state }
   *   role       'host' (made the invite) or 'guest'
   *   seatToken  proves to the relay which seat is ours when we reconnect
   *   sendN      counter on messages we send; lastSeen, on theirs
   *   state      the shared game (see protocol.js), null until the guest hears
   */
  var session = null;
  var active = false; // the board is showing the online game
  var room = null; // { roomId, key } for the session
  var client = null;
  var generation = 0; // bumps when we stop, so late replies are ignored
  var linkStatus = 'idle'; // RelayClient status
  var stopReason = null;
  var peerOnline = false;
  var pending = null; // our request awaiting their answer: { id, kind }
  var incoming = null; // their request awaiting ours: { id, kind }
  var pendingJoin = null; // an invite awaiting confirmation: { secret, relay }
  var outbox = Promise.resolve();
  var inbox = Promise.resolve();
  var currentPanel = null;
  var sharedStats = null; // the house relay's last /v1/stats answer
  var house = null; // { url, public } once found; see findHouse
  var houseSearch = null;

  /* -------------------------------------------------------------- storage */

  function readJson(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || 'null');
    } catch (err) {
      return null;
    }
  }

  function writeJson(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (err) {
      /* private browsing: the game still works until the page is closed */
    }
  }

  function persist() {
    writeJson(SESSION_KEY, session);
  }

  function loadSession() {
    var s = readJson(SESSION_KEY);
    var ok =
      s &&
      P.normalizeRelay(s.relay) === s.relay &&
      C.isSecret(s.secret) &&
      (s.role === 'host' || s.role === 'guest') &&
      P.isToken(s.seatToken) &&
      typeof s.sendN === 'number' &&
      typeof s.lastSeen === 'number' &&
      (s.state === null || P.validState(s.state));
    return ok ? s : null;
  }

  /* The relay this device hosts on, once it has been checked. */
  function relayConfig() {
    var stored = readJson(RELAY_KEY);
    if (!stored || !stored.verified) return null;
    var url = P.normalizeRelay(stored.url);
    return url && P.isOwnerKey(stored.key) ? { url: url, key: stored.key } : null;
  }

  /*
   * Find this site's relay: the Worker serving this page, else the shared
   * relay from config.js. Asked once per page load. Resolves to
   * { url, public } or null.
   */
  function findHouse() {
    if (!houseSearch) {
      var candidates = [location.origin];
      if (SHARED_RELAY && SHARED_RELAY !== location.origin) candidates.push(SHARED_RELAY);
      houseSearch = candidates
        .reduce(function (found, url) {
          return found.then(function (relay) {
            return relay || probeRelay(url);
          });
        }, Promise.resolve(null))
        .then(function (relay) {
          house = relay;
          return relay;
        });
    }
    return houseSearch;
  }

  function probeRelay(address) {
    var url = P.normalizeRelay(address);
    if (!url) return Promise.resolve(null);
    return fetch(url + '/v1/info', { cache: 'no-store' })
      .then(function (response) {
        return response.ok ? response.json() : null;
      })
      .then(function (info) {
        var usable = info && info.app === 'farboard-relay' && info.proto === P.PROTO && info.originAllowed;
        return usable ? { url: url, public: !!info.publicHosting } : null;
      })
      .catch(function () {
        return null;
      });
  }

  /* Where this device hosts: { url, key, own } or null if nowhere (yet). */
  function hostingRelay() {
    var own = relayConfig();
    if (own) return { url: own.url, key: own.key, own: true };
    if (house && house.public) return { url: house.url, key: null, own: false };
    return null;
  }

  function pageBase() {
    return location.origin + location.pathname;
  }

  /* --------------------------------------------------------------- colours */

  function myColor() {
    return session && session.state ? P.colorFor(session.role, session.state.hostColor) : null;
  }

  function peerColor() {
    var mine = myColor();
    return mine && P.otherColor(mine);
  }

  /* --------------------------------------------------------- the session */

  /* Show the online game on the board and start talking to the relay. */
  function enter() {
    active = true;
    pending = null;
    incoming = null;
    showState();
    el.onlineCard.hidden = false;
    updateHeader();
    connect();
  }

  /* Back to the local board. The online game is kept to resume later. */
  function leave() {
    disconnect();
    active = false;
    pending = null;
    incoming = null;
    app.setOnline(null);
    el.onlineCard.hidden = true;
    document.title = baseTitle;
    updateHeader();
  }

  function forget() {
    if (active) leave();
    session = null;
    persist();
    updateHeader();
  }

  /*
   * Leave the online game for good. The relay is told, so the opponent hears
   * about it (now, or when they next connect) instead of waiting for someone
   * who will never come back. Over the live connection if there is one,
   * otherwise over a short one made just for this.
   */
  function leaveForGood() {
    if (!session) return;
    var old = session;
    var told = !!client && client.leave();
    forget();
    if (!told) tellRelayWeLeft(old);
  }

  function tellRelayWeLeft(old) {
    C.deriveRoom(old.secret)
      .then(function (derived) {
        var once = new RelayClient({
          relay: old.relay,
          roomId: derived.roomId,
          seatToken: old.seatToken,
          onStatus: function (status) {
            if (status === 'connected') once.leave();
            else if (status === 'reconnecting' || status === 'stopped') once.stop(); // best effort only
          },
          onPeer: function () {},
          onFrame: function () {}
        });
        once.connect();
      })
      .catch(function () {
        /* nothing more to do */
      });
  }

  function showState() {
    var s = session.state;
    var outcome = s && s.outcome ? P.outcomeText(s.outcome) : null;
    if (!outcome && session.peerLeft && !(s && P.gameOver(s))) outcome = 'Your opponent left the game';
    app.setOnline({ color: myColor(), outcome: outcome });
    app.loadGame(s ? s.moves.map(P.decodeMove) : []);
    renderCard();
  }

  function connect() {
    disconnect();
    var gen = generation;
    stopReason = null;
    linkStatus = 'connecting';
    renderCard();

    C.deriveRoom(session.secret)
      .then(function (derived) {
        if (gen !== generation) return;
        room = derived;
        var hosting = relayConfig();
        client = new RelayClient({
          relay: session.relay,
          roomId: room.roomId,
          seatToken: session.seatToken,
          create: session.role === 'host',
          // Only needed the first time, to create the room; harmless after.
          ownerKey:
            session.role === 'host' && hosting && hosting.url === session.relay ? hosting.key : null,
          onStatus: function (status, detail) {
            if (gen === generation) onStatus(status, detail);
          },
          onPeer: function (online, left) {
            if (gen === generation) onPeer(online, left);
          },
          onFrame: function (frame) {
            if (gen === generation) onFrame(frame);
          }
        });
        client.connect();
      })
      .catch(function (err) {
        onStatus('stopped', 'crypto');
        console.warn('[online]', err);
      });
  }

  function disconnect() {
    generation++;
    if (client) client.stop();
    client = null;
    room = null;
    peerOnline = false;
    linkStatus = 'idle';
  }

  /* ------------------------------------------------------------ the link */

  var STOP_MESSAGES = {
    'no-game': {
      host: 'The relay would not start this game. A private relay needs its owner key (Play online → I’m the owner).',
      guest: 'This game is no longer on the relay. It may have expired; ask for a new invite.'
    },
    full: 'This game already has two players.',
    replaced: 'This game is open in another tab or window.',
    expired: 'This game expired after a week without moves.',
    'room-limit': 'This game has used its messages for today. It will work again after midnight UTC.',
    left: 'You left this game on another tab or device.',
    ended: 'This game has ended: both players have left it.',
    'bad-request': 'The relay refused the connection. It may need updating.',
    crypto: 'This browser cannot play online (it needs a secure https:// page).'
  };

  function onStatus(status, detail) {
    // A shared relay that turns down a new game: the game never existed, so
    // drop it and say why where the host asked for it.
    if (status === 'stopped' && (detail === 'daily-limit' || detail === 'network-limit')) {
      forget();
      openMenu(detail === 'daily-limit' ? dailyLimitText(null) : networkLimitText());
      return;
    }
    linkStatus = status;
    if (status !== 'connected') peerOnline = false;
    if (status === 'stopped') {
      var message = STOP_MESSAGES[detail] || STOP_MESSAGES['bad-request'];
      stopReason = typeof message === 'string' ? message : message[session.role];
    }
    renderCard();
  }

  function onPeer(online, left) {
    if (left && !session.peerLeft) {
      session.peerLeft = true;
      pending = null;
      incoming = null;
      persist();
      showState();
      app.flash('Your opponent left the game.');
      nudge('Your opponent left');
    }
    var arrived = online && !peerOnline;
    peerOnline = online;
    // Every time the other side (re)appears, compare notes; this is also how
    // anything missed while one of us was offline gets caught up.
    if (online) sendSync();
    if (arrived && currentPanel === 'invite') {
      el.inviteStatus.textContent = 'Your opponent is here. Have a good game!';
      setTimeout(function () {
        if (currentPanel === 'invite') closeModal();
      }, 1200);
    }
    renderCard();
  }

  /* ------------------------------------------------------------ messages */

  function send(body) {
    if (!client || !room) return;
    session.sendN += 1;
    persist();
    var message = P.wrap(session.role, session.sendN, body);
    var key = room.key;
    var target = client;
    outbox = outbox
      .then(function () {
        return C.seal(key, message);
      })
      .then(function (frame) {
        target.send(frame);
      })
      .catch(function (err) {
        console.warn('[online] could not send', err);
      });
  }

  function sendSync() {
    send({ t: 'sync', state: session.state ? P.copyState(session.state) : null });
  }

  function onFrame(frame) {
    var key = room.key;
    var gen = generation;
    inbox = inbox
      .then(function () {
        return C.open(key, frame);
      })
      .then(function (plain) {
        if (gen !== generation || !session) return;
        var body = P.unwrap(plain, session.role, session.lastSeen);
        if (!body) return;
        session.lastSeen = plain.n;
        persist();
        handle(body);
      })
      .catch(function (err) {
        console.warn('[online] ignored a message:', err && err.message);
      });
  }

  function handle(body) {
    if (body.t === 'sync') adopt(body.state, false);
    else if (body.t === 'move') receiveMove(body);
    else if (body.t === 'request') receiveRequest(body);
    else if (body.t === 'reply') receiveReply(body);
  }

  /* Merge a state the other side sent into ours (see protocol.mergeState). */
  function adopt(theirs, quiet) {
    var before = session.state;
    var result = P.mergeState(before, theirs, session.role === 'host');

    if (result.changed) {
      session.state = result.state;
      persist();
      if (!before || before.rev !== result.state.rev) {
        pending = null;
        incoming = null;
      }
      showState();
      if (!quiet) announceChange(before, result.state);
    }
    if (result.notice === 'diverged') app.flash('Your copies of the game differed; the host’s was kept.');
    if (result.notice === 'rejected') console.warn('[online] refused a game state from the other side');
    if (result.sendBack) sendSync();
  }

  function announceChange(before, after) {
    if (!before) {
      app.flash('Connected. You play ' + COLOR_NAMES[myColor()] + '.');
      nudge('Game on');
    } else if (after.game !== before.game) {
      app.flash('New game. You play ' + COLOR_NAMES[myColor()] + '.');
      nudge('New game');
    } else if (after.outcome && !before.outcome) {
      app.flash(P.outcomeText(after.outcome) + '.');
      nudge('Game over');
    } else if (after.moves.length < before.moves.length) {
      app.flash('Moves were taken back.');
    } else if (after.moves.length > before.moves.length) {
      nudge('Your move');
    }
  }

  function receiveMove(body) {
    var verdict = P.checkMove(session.state, body, peerColor());
    if (verdict === 'apply') {
      var played = app.applyRemoteMove(P.decodeMove(body.m));
      if (!played) {
        // The board and the saved state disagree; redraw from the state.
        showState();
        sendSync();
        return;
      }
      session.state.moves.push(body.m);
      persist();
      renderCard();
      app.flash('Opponent played ' + played.san + '.');
      nudge('Your move');
    } else if (verdict === 'resync') {
      sendSync();
    } else if (verdict === 'reject') {
      console.warn('[online] refused a move from the other side', body);
    }
  }

  /* ------------------------------------------------------------ requests */

  var REQUEST_TEXT = {
    takeback: 'Your opponent asks to take back their last move.',
    draw: 'Your opponent offers a draw.',
    newgame: 'Your opponent asks for a new game (colours swap).'
  };
  var ASKED_TEXT = {
    takeback: 'Asked to take back your move…',
    draw: 'Offered a draw…',
    newgame: 'Asked for a new game…'
  };
  var ACCEPTED_TEXT = {
    takeback: 'Move taken back.',
    draw: 'Draw agreed.',
    newgame: 'New game started.'
  };
  var DECLINED_TEXT = {
    takeback: 'Your opponent declined the take-back.',
    draw: 'Your opponent declined the draw.',
    newgame: 'Your opponent declined a new game.'
  };

  /* Ask the other side (take-back, draw or new game). */
  function request(kind) {
    if (!active || !session || !session.state) return;
    if (session.peerLeft) {
      // Nobody to ask. A new game means a new invite.
      if (kind !== 'newgame') return app.flash('Your opponent has left this game.');
      leaveForGood();
      return openMenu();
    }
    var s = session.state;
    if (!peerOnline) return app.flash('Your opponent is not connected right now.');
    if (pending) return app.flash('Still waiting for an answer to your last request.');
    if (kind === 'takeback' && (s.outcome || !P.takebackPlies(s.moves, myColor()))) {
      return app.flash('There is no move of yours to take back.');
    }
    if (kind === 'draw' && P.gameOver(s)) return app.flash('The game is already over.');
    if (
      kind === 'newgame' &&
      !P.gameOver(s) &&
      !window.confirm('Ask for a new game? This one would be abandoned.')
    ) {
      return;
    }
    pending = { id: C.randomToken(9), kind: kind };
    send({ t: 'request', id: pending.id, kind: kind });
    renderCard();
  }

  function receiveRequest(body) {
    var grantable = session.state && P.resolveRequest(session.state, body.kind, body.id, peerColor());
    if (!grantable) {
      send({ t: 'reply', id: body.id, accept: false });
      return;
    }
    incoming = { id: body.id, kind: body.kind };
    renderCard();
    nudge('Your opponent is asking');
  }

  function answer(accept) {
    if (!incoming) return;
    var req = incoming;
    incoming = null;
    // Worked out again now: the position may have moved on since they asked.
    var next = accept && P.resolveRequest(session.state, req.kind, req.id, peerColor());
    if (next) {
      session.state = next;
      pending = null;
      persist();
      showState();
      send({ t: 'reply', id: req.id, accept: true, state: P.copyState(next) });
      app.flash(ACCEPTED_TEXT[req.kind]);
    } else {
      send({ t: 'reply', id: req.id, accept: false });
    }
    renderCard();
  }

  function receiveReply(body) {
    var mine = pending && pending.id === body.id ? pending : null;
    if (mine) pending = null;
    if (body.accept && body.state) adopt(body.state, true);
    if (mine) app.flash(body.accept ? ACCEPTED_TEXT[mine.kind] : DECLINED_TEXT[mine.kind]);
    renderCard();
  }

  function resign() {
    if (!session || !session.state || P.gameOver(session.state)) return;
    if (!window.confirm('Resign this game?')) return;
    var next = P.resign(session.state, myColor());
    if (!next) return;
    session.state = next;
    pending = null;
    incoming = null;
    persist();
    showState();
    sendSync();
  }

  /* The board's own move, already played there; tell the other side. */
  function onLocalMove(move) {
    if (!active || !session || !session.state) return;
    var ply = session.state.moves.length;
    var m = P.encodeMove(move);
    session.state.moves.push(m);
    persist();
    send({ t: 'move', rev: session.state.rev, ply: ply, m: m });
    renderCard();
  }

  /* Put a marker in the tab title when something happens while you are away. */
  function nudge(text) {
    if (document.hidden) document.title = '● ' + text + ' — Farboard';
  }

  /* ---------------------------------------------------------------- card */

  function renderCard() {
    if (!active || !session) return;
    var color = myColor();
    var s = session.state;
    var over = !!s && P.gameOver(s);
    var status;
    var tone;

    if (linkStatus === 'stopped') {
      status = stopReason;
      tone = 'bad';
    } else if (session.peerLeft) {
      status = 'Your opponent left this game.';
      tone = 'bad';
    } else if (linkStatus !== 'connected') {
      status = linkStatus === 'reconnecting' ? 'Reconnecting…' : 'Connecting to the relay…';
      tone = 'wait';
    } else if (!peerOnline) {
      var waitingForGuest = session.role === 'host' && s && s.rev === 0 && !s.moves.length;
      status = waitingForGuest
        ? 'Waiting for your opponent to open the invite.'
        : 'Your opponent is offline. The game carries on when they come back.';
      tone = 'wait';
    } else {
      status = 'Connected to your opponent.';
      tone = 'ok';
    }

    el.netStatus.textContent = status;
    el.netDot.className = 'net-dot ' + tone;
    el.netDetail.textContent =
      (color ? 'You play ' + COLOR_NAMES[color] : 'Joining') + ' · via ' + P.relayLabel(session.relay);

    if (incoming) {
      el.requestText.textContent = REQUEST_TEXT[incoming.kind];
      el.requestButtons.hidden = false;
    } else if (pending) {
      el.requestText.textContent = ASKED_TEXT[pending.kind];
      el.requestButtons.hidden = true;
    }
    el.requestBanner.hidden = !incoming && !pending;

    el.drawBtn.disabled = !color || over || !peerOnline || !!pending || !!session.peerLeft;
    el.resignBtn.disabled = !color || over || !!session.peerLeft;
    el.reconnectBtn.hidden = linkStatus !== 'stopped';
    el.inviteAgainBtn.hidden = session.role !== 'host' || !!session.peerLeft;
    el.localBoardBtn.textContent = session.peerLeft ? 'Close game' : 'Local board';
  }

  function updateHeader() {
    el.onlineBtn.textContent = active ? 'Online game' : 'Play online';
  }

  /* -------------------------------------------------------------- dialogs */

  function openModal(panel) {
    currentPanel = panel;
    el.onlineTitle.textContent = TITLES[panel];
    el.panels.forEach(function (section) {
      section.hidden = section.dataset.panel !== panel;
    });
    el.modal.hidden = false;
    var first = el.modal.querySelector('[data-panel="' + panel + '"] .btn-primary:not([hidden])');
    (first || el.onlineClose).focus();
  }

  function closeModal() {
    el.modal.hidden = true;
    currentPanel = null;
  }

  /* message: shown in the hosting section, e.g. why a game was refused. */
  function openMenu(message) {
    el.hostError.textContent = typeof message === 'string' ? message : '';
    el.hostChecking.hidden = false;
    el.hostReady.hidden = true;
    el.hostOwnerOnly.hidden = true;
    el.hostSetupNeeded.hidden = true;
    findHouse().then(renderHosting);

    el.currentSection.hidden = !session;
    if (session) {
      var color = myColor();
      var who = color ? ' (you play ' + COLOR_NAMES[color] + ')' : '';
      if (session.peerLeft) {
        el.currentText.textContent = 'Your opponent left your online game' + who + '.';
        el.currentMainBtn.textContent = active ? 'Back to local board' : 'Look at it';
      } else if (active) {
        el.currentText.textContent = 'You are in an online game' + who + '.';
        el.currentMainBtn.textContent = 'Back to local board';
      } else {
        var moves = session.state ? session.state.moves.length : 0;
        el.currentText.textContent =
          'You have an online game in progress' + who + ', ' + moves + (moves === 1 ? ' move' : ' moves') + ' so far.';
        el.currentMainBtn.textContent = 'Resume it';
      }
    }
    el.joinError.textContent = '';
    openModal('menu');
  }

  /* The hosting part of the menu, once we know which relay this site has. */
  function renderHosting() {
    if (currentPanel !== 'menu') return;
    var own = relayConfig();
    var hosting = hostingRelay();
    var ours = house && house.url === location.origin;
    el.hostChecking.hidden = true;
    el.hostReady.hidden = !hosting;
    el.hostOwnerOnly.hidden = !!hosting || !house;
    el.hostSetupNeeded.hidden = !!hosting || !!house;
    el.hostStats.textContent = '';
    el.createInviteBtn.disabled = false;
    el.ownerLinkWrap.hidden = !!own;
    el.sharedNote.hidden = !!own;
    el.ownerNote.hidden = !own;
    showRelayWhat(false);
    if (!hosting) return;

    if (own) {
      el.ownerNote.textContent =
        house && own.url === house.url
          ? 'You host as ' + (ours ? 'this site' : 'the relay') + '’s owner, with no daily limit.'
          : 'Games go through your relay at ' + P.relayLabel(own.url) + '.';
      el.changeRelayBtn.textContent = 'Owner key';
    } else {
      el.changeRelayBtn.textContent = 'Get your own copy';
      loadStats(house.url);
    }
  }

  /* "shared relay" opens a short explanation in place; tooltips do not work on phones. */
  function showRelayWhat(open) {
    el.relayWhat.hidden = !open;
    el.relayWhatBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  /* How many new games the house relay has left today. */
  function loadStats(url) {
    fetch(url + '/v1/stats', { cache: 'no-store' })
      .then(function (response) {
        return response.json();
      })
      .then(function (stats) {
        sharedStats = stats;
        if (currentPanel !== 'menu') return;
        if (!stats.publicHosting) {
          el.hostStats.textContent = 'It is not taking new games at the moment.';
          el.createInviteBtn.disabled = true;
        } else if (stats.remaining <= 0) {
          el.hostStats.textContent = dailyLimitText(stats);
          el.createInviteBtn.disabled = true;
        } else {
          el.hostStats.textContent =
            stats.remaining + ' out of ' + stats.dailyLimit + ' games left for anyone to use today.';
        }
      })
      .catch(function () {
        /* the relay itself will say no if it has to */
      });
  }

  function dailyLimitText(stats) {
    stats = stats || sharedStats;
    var all = stats && stats.dailyLimit ? 'All ' + stats.dailyLimit + ' of today’s games' : 'Today’s games';
    var wait = stats && stats.resetsAt ? ' (' + untilText(Date.parse(stats.resetsAt)) + ')' : '';
    return (
      all +
      ' have been used. New games open again at midnight UTC' +
      wait +
      '; games already under way carry on.'
    );
  }

  function networkLimitText() {
    return 'Too many new games from your network in the last hour. Try again a little later.';
  }

  function untilText(when) {
    var minutes = Math.max(1, Math.round((when - Date.now()) / 60000));
    var hours = Math.floor(minutes / 60);
    return 'in ' + (hours ? hours + ' h ' : '') + (minutes % 60) + ' min';
  }

  function describeHostColor() {
    var picked = el.modal.querySelector('input[name="hostColor"]:checked');
    var value = picked ? picked.value : 'w';
    if (value === 'random') return Math.random() < 0.5 ? 'w' : 'b';
    return value;
  }

  function hostGame() {
    var hosting = hostingRelay();
    if (!hosting) return openMenu();
    if (session && !window.confirm('Start a new online game? You will leave the one you have now.')) return;
    leaveForGood();
    session = {
      v: 1,
      relay: hosting.url,
      secret: C.newSecret(),
      role: 'host',
      seatToken: C.randomToken(16),
      sendN: 0,
      lastSeen: 0,
      state: P.newState(C.randomToken(9), describeHostColor())
    };
    persist();
    enter();
    showInvite();
  }

  function showInvite() {
    if (!session) return;
    var link = P.inviteLink(pageBase(), session.secret, session.relay);
    el.inviteLink.value = link;
    drawQr(el.inviteQr, link, 'QR code for the invite link');
    el.shareInviteBtn.hidden = !navigator.share;
    el.inviteStatus.textContent = peerOnline
      ? 'Your opponent is connected.'
      : 'Waiting for your opponent to open the link…';
    openModal('invite');
  }

  /* An invite arrived (address bar or pasted). Ask before joining. */
  function offerJoin(link) {
    if (session && session.secret === link.secret) {
      // Our own game (a reload, or the host opening their own link).
      closeModal();
      if (!active) enter();
      return;
    }
    pendingJoin = link;
    el.joinRelayName.textContent = P.relayLabel(link.relay);
    el.joinReplaceNote.hidden = !session;
    openModal('join');
  }

  function confirmJoin() {
    var link = pendingJoin;
    pendingJoin = null;
    if (!link) return;
    leaveForGood();
    session = {
      v: 1,
      relay: link.relay,
      secret: link.secret,
      role: 'guest',
      seatToken: C.randomToken(16),
      sendN: 0,
      lastSeen: 0,
      state: null
    };
    persist();
    closeModal();
    enter();
  }

  function joinFromPaste() {
    var link = P.parseLink(el.joinInput.value.trim());
    if (link && link.join) {
      el.joinInput.value = '';
      offerJoin(link.join);
    } else if (link && link.setup) {
      el.joinInput.value = '';
      openOwner(link.setup);
    } else {
      el.joinError.textContent = 'That is not a Farboard invite link.';
    }
  }

  /* ---------------------------------------------------------------- setup */

  /* Get your own copy: a key to deploy with, the button, then off to the copy. */
  function openCopy() {
    var key = readJson(DRAFT_KEY);
    if (!P.isOwnerKey(key)) {
      // Saved straight away: once it is pasted into Cloudflare it must not change.
      key = C.randomToken(32);
      writeJson(DRAFT_KEY, key);
    }
    el.draftKeyInput.value = key;
    el.deployLink.href = DEPLOY_URL;
    el.copyAddressInput.value = '';
    el.copyResult.textContent = '';
    openModal('copy');
  }

  /* Hand the key to the new copy through a setup link; it checks it there. */
  function openCopyTarget() {
    var url = P.normalizeRelay(el.copyAddressInput.value);
    var key = el.draftKeyInput.value;
    if (!url) {
      el.copyResult.textContent = 'That does not look like an address. It should look like farboard.yourname.workers.dev.';
      el.copyResult.className = 'form-message bad';
      return;
    }
    if (url === location.origin) return openOwner({ relay: url, key: key });
    window.open(P.setupLink(url + '/', url, key), '_blank', 'noopener');
    el.copyResult.textContent = 'Opened your copy in a new tab. Choose Check & save there.';
    el.copyResult.className = 'form-message good';
  }

  /*
   * The owner key for a relay. prefill: { relay, key? } from a setup link or
   * "I'm the owner", or null to show what is saved.
   */
  function openOwner(prefill) {
    var stored = readJson(RELAY_KEY) || {};
    var url =
      (prefill && prefill.relay) || P.normalizeRelay(stored.url) || (house ? house.url : null);
    el.relayInput.value = url ? P.relayLabel(url) : '';
    el.ownerKeyInput.value = (prefill && prefill.key) || stored.key || '';
    el.otherDeviceSection.hidden = true;
    el.otherDeviceBtn.disabled = !relayConfig();

    if (prefill && prefill.key) {
      setResult('Choose Check & save to use this key on this device.', '');
    } else if (relayConfig() && !prefill) {
      setResult('✓ Saved and working.', 'good');
    } else {
      setResult('', '');
    }
    openModal('owner');
    (el.ownerKeyInput.value ? el.checkRelayBtn : el.ownerKeyInput).focus();
  }

  function setResult(text, tone) {
    el.relayResult.textContent = text;
    el.relayResult.className = 'form-message' + (tone ? ' ' + tone : '');
  }

  function problem(message) {
    var err = new Error(message);
    err.userFacing = true;
    return err;
  }

  function checkRelay() {
    var url = P.normalizeRelay(el.relayInput.value);
    var key = el.ownerKeyInput.value.trim();
    if (!url) {
      return setResult(
        'That does not look like a relay address. It should look like chess-relay.yourname.workers.dev.',
        'bad'
      );
    }
    if (!P.isOwnerKey(key)) return setResult('The owner key should be at least 16 characters.', 'bad');

    setResult('Checking…', '');
    el.checkRelayBtn.disabled = true;
    fetch(url + '/v1/info', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw problem('That address answered, but it is not a Farboard relay.');
        return response.json().catch(function () {
          throw problem('That address answered, but it is not a Farboard relay.');
        });
      })
      .then(function (info) {
        if (!info || info.app !== 'farboard-relay') {
          throw problem('That address answered, but it is not a Farboard relay.');
        }
        if (info.proto !== P.PROTO) {
          throw problem('This relay runs a different version of Farboard. Update it by deploying again.');
        }
        if (!info.ownerKeySet) {
          throw problem(
            'The relay has no OWNER_KEY yet. In Cloudflare, open the Worker → Settings → Variables and Secrets, add OWNER_KEY with this key, then check again.'
          );
        }
        if (!info.originAllowed) {
          throw problem(
            'The relay does not accept games from ' +
              location.origin +
              '. Add it to ALLOWED_ORIGINS in the Worker’s settings.'
          );
        }
        return fetch(url + '/v1/verify', {
          method: 'POST',
          cache: 'no-store',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ key: key })
        });
      })
      .then(function (response) {
        if (response.status === 401) {
          throw problem(
            'That is not this relay’s owner key. Use the same key as OWNER_KEY in Cloudflare.'
          );
        }
        if (response.status !== 204) throw problem('The relay refused the check (HTTP ' + response.status + ').');
        writeJson(RELAY_KEY, { url: url, key: key, verified: true });
        el.relayInput.value = P.relayLabel(url);
        el.otherDeviceBtn.disabled = false;
        setResult('✓ Saved. You can host games on this relay now.', 'good');
      })
      .catch(function (err) {
        setResult(
          err && err.userFacing
            ? err.message
            : 'Could not reach ' + P.relayLabel(url) + '. Check the address, and that the deploy has finished.',
          'bad'
        );
      })
      .then(function () {
        el.checkRelayBtn.disabled = false;
      });
  }

  function showOtherDevice() {
    var hosting = relayConfig();
    if (!hosting) return;
    drawQr(el.setupQr, P.setupLink(pageBase(), hosting.url, hosting.key), 'QR code with your relay settings');
    el.otherDeviceSection.hidden = false;
  }

  function forgetRelay() {
    var ok = window.confirm('Forget the owner key on this device? Keep a copy of it if you will need it again.');
    if (!ok) return;
    writeJson(RELAY_KEY, null);
    openOwner(null);
  }

  /* ------------------------------------------------------------------- QR */

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function drawQr(container, text, label) {
    var qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    var count = qr.getModuleCount();
    var quiet = 4; // the blank margin scanners need
    var size = count + quiet * 2;
    var d = '';
    for (var row = 0; row < count; row++) {
      for (var col = 0; col < count; col++) {
        if (qr.isDark(row, col)) d += 'M' + (col + quiet) + ' ' + (row + quiet) + 'h1v1h-1z';
      }
    }

    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 ' + size + ' ' + size);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.setAttribute('shape-rendering', 'crispEdges');

    var background = document.createElementNS(SVG_NS, 'rect');
    background.setAttribute('width', size);
    background.setAttribute('height', size);
    background.setAttribute('class', 'qr-light');
    svg.appendChild(background);

    var modules = document.createElementNS(SVG_NS, 'path');
    modules.setAttribute('d', d);
    modules.setAttribute('class', 'qr-dark');
    svg.appendChild(modules);

    container.replaceChildren(svg);
  }

  /* ------------------------------------------------------------- the URL */

  /* Pick up an invite or setup link, then wipe it from the address bar. */
  function readAddressBar() {
    var link = P.parseLink(location.hash);
    if (!link) return false;
    // The secret must not linger in history, bookmarks or screenshots.
    history.replaceState(null, '', location.pathname + location.search);
    if (link.join) offerJoin(link.join);
    else openOwner(link.setup);
    return true;
  }

  /* --------------------------------------------------------------- wiring */

  function cacheElements() {
    [
      'onlineBtn',
      'onlineCard',
      'netDot',
      'netStatus',
      'netDetail',
      'requestBanner',
      'requestText',
      'requestButtons',
      'requestAccept',
      'requestDecline',
      'drawBtn',
      'resignBtn',
      'reconnectBtn',
      'inviteAgainBtn',
      'localBoardBtn',
      'onlineTitle',
      'onlineClose',
      'currentSection',
      'currentText',
      'currentMainBtn',
      'currentLeaveBtn',
      'hostChecking',
      'hostReady',
      'hostOwnerOnly',
      'imOwnerBtn',
      'ownerOnlyCopyBtn',
      'haveRelayBtn',
      'hostSetupNeeded',
      'sharedNote',
      'relayWhatBtn',
      'relayWhat',
      'ownerNote',
      'hostStats',
      'hostError',
      'changeRelayBtn',
      'ownerLinkWrap',
      'ownerLinkBtn',
      'createInviteBtn',
      'setupBtn',
      'joinInput',
      'joinPasteBtn',
      'joinError',
      'ownerKeyInput',
      'draftKeyInput',
      'copyKeyBtn',
      'deployLink',
      'copyAddressInput',
      'openCopyBtn',
      'copyResult',
      'copyBackBtn',
      'relayInput',
      'checkRelayBtn',
      'relayResult',
      'otherDeviceSection',
      'setupQr',
      'setupBackBtn',
      'otherDeviceBtn',
      'forgetRelayBtn',
      'inviteQr',
      'inviteLink',
      'copyInviteBtn',
      'inviteStatus',
      'shareInviteBtn',
      'inviteDoneBtn',
      'joinRelayName',
      'joinReplaceNote',
      'joinConfirmBtn',
      'joinCancelBtn'
    ].forEach(function (id) {
      el[id] = document.getElementById(id);
    });
    el.modal = document.getElementById('onlineModal');
    el.panels = Array.prototype.slice.call(el.modal.querySelectorAll('[data-panel]'));
  }

  function on(element, handler) {
    element.addEventListener('click', handler);
  }

  function bindEvents() {
    on(el.onlineBtn, openMenu);
    on(el.onlineClose, closeModal);
    el.modal.addEventListener('click', function (event) {
      if (event.target === el.modal) closeModal();
    });
    // Keys typed in the dialog are the dialog's, not the board's shortcuts.
    el.modal.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeModal();
      event.stopPropagation();
    });

    // Menu
    on(el.currentMainBtn, function () {
      if (active) {
        leave();
      } else {
        enter();
      }
      closeModal();
    });
    on(el.currentLeaveBtn, function () {
      if (!window.confirm('Leave this online game for good? You will not be able to rejoin it.')) return;
      leaveForGood();
      openMenu();
    });
    on(el.setupBtn, openCopy);
    on(el.ownerOnlyCopyBtn, openCopy);
    on(el.haveRelayBtn, function () {
      openOwner(null);
    });
    on(el.imOwnerBtn, function () {
      openOwner(house ? { relay: house.url } : null);
    });
    on(el.relayWhatBtn, function () {
      showRelayWhat(el.relayWhat.hidden);
    });
    on(el.ownerLinkBtn, function () {
      openOwner(house ? { relay: house.url } : null);
    });
    on(el.changeRelayBtn, function () {
      if (relayConfig()) openOwner(null);
      else openCopy();
    });
    on(el.createInviteBtn, hostGame);
    on(el.joinPasteBtn, joinFromPaste);
    el.joinInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') joinFromPaste();
    });

    // Get your own copy
    on(el.copyKeyBtn, function () {
      app.copyText(el.draftKeyInput.value, 'Owner key');
    });
    on(el.openCopyBtn, openCopyTarget);
    el.copyAddressInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') openCopyTarget();
    });
    on(el.copyBackBtn, openMenu);

    // Owner key
    on(el.checkRelayBtn, checkRelay);
    el.ownerKeyInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') checkRelay();
    });
    on(el.setupBackBtn, openMenu);
    on(el.otherDeviceBtn, showOtherDevice);
    on(el.forgetRelayBtn, forgetRelay);

    // Invite
    on(el.copyInviteBtn, function () {
      app.copyText(el.inviteLink.value, 'Invite link');
    });
    on(el.shareInviteBtn, function () {
      navigator
        .share({ title: 'Farboard', text: 'Play a game of chess with me', url: el.inviteLink.value })
        .catch(function () {
          /* cancelled */
        });
    });
    on(el.inviteDoneBtn, closeModal);

    // Join
    on(el.joinConfirmBtn, confirmJoin);
    on(el.joinCancelBtn, function () {
      pendingJoin = null;
      closeModal();
    });

    // Card
    on(el.requestAccept, function () {
      answer(true);
    });
    on(el.requestDecline, function () {
      answer(false);
    });
    on(el.drawBtn, function () {
      request('draw');
    });
    on(el.resignBtn, resign);
    on(el.reconnectBtn, connect);
    on(el.inviteAgainBtn, showInvite);
    on(el.localBoardBtn, function () {
      if (session && session.peerLeft) leaveForGood();
      else leave();
    });

    window.addEventListener('hashchange', readAddressBar);
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) document.title = baseTitle;
    });
  }

  function init() {
    app = window.Farboard;
    cacheElements();
    bindEvents();
    app.onLocalMove(onLocalMove);
    app.onAction(request);
    session = loadSession();
    updateHeader();
    // An online game in progress is offered, never switched to silently.
    if (!readAddressBar() && session) openMenu();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
