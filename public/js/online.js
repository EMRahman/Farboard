/*
 * online.js — playing someone on another device, through a relay.
 *
 * On load this file looks at the address bar for an invite or a setup link.
 * Otherwise it resumes the game saved on this device, or, with none, shows
 * the home card: host a game, or how to join one.
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
 *   farboard:name:v1    the name last used, offered again next time
 *   farboard:chat:v1    the chat of the game in progress (see chat.js)
 */
(function () {
  'use strict';

  var P = window.ChessProtocol;
  var C = window.NetCrypto;
  var Chat = window.ChatRules;
  var CL = Chat.LIMITS;
  var RelayClient = window.RelayClient;

  var SESSION_KEY = 'farboard:online:v1';
  var RELAY_KEY = 'farboard:relay:v1';
  var DRAFT_KEY = 'farboard:draft:v1';
  var NAME_KEY = 'farboard:name:v1';
  var CHAT_KEY = 'farboard:chat:v1';

  var CONFIG = window.FarboardConfig || {};
  var SHARED_RELAY = P.normalizeRelay(CONFIG.sharedRelay);
  var DEPLOY_URL = CONFIG.deployUrl || '';

  var TITLES = {
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
   *   name, peerName   the two players' names ('' if none); peerVerified is
   *              true once the name has come over the sealed channel rather
   *              than from the invite link, which anyone could have edited
   *   peerChat   the other side's app supports chat
   *   chatGame, chatSent, chatRecv, chatMuted   chat allowance for this game
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
  var homeVisible = false;
  var outbox = Promise.resolve();
  var inbox = Promise.resolve();
  var currentPanel = null;
  var sharedStats = null; // the house relay's last /v1/stats answer
  var house = null; // { url, public } once found; see findHouse
  var houseSearch = null;
  // Chat on this device: items are { who: 'me' | 'peer' | 'sys', text }.
  // visible: the chat card is on screen (desktop); sheetOpen: the phone's sheet is up.
  var chat = { items: [], bucket: null, inBucket: null, strikes: 0, unread: 0, visible: true, sheetOpen: false };
  var PHONE = window.matchMedia('(max-width: 860px)');

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
    if (!ok) return null;
    s.name = Chat.cleanName(s.name);
    s.peerName = Chat.cleanName(s.peerName);
    s.chatSent = s.chatSent > 0 ? s.chatSent : 0;
    s.chatRecv = s.chatRecv > 0 ? s.chatRecv : 0;
    return s;
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

  function savedName() {
    var saved = readJson(NAME_KEY);
    return typeof saved === 'string' ? Chat.cleanName(saved) : '';
  }

  /* Clean a typed name and keep it for next time. */
  function rememberName(typed) {
    var name = Chat.cleanName(typed);
    if (name) writeJson(NAME_KEY, name);
    return name;
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

  function myName() {
    return (session && session.name) || '';
  }

  function peerName() {
    return Chat.peerLabel(session && session.peerName, myName());
  }

  /* Show the game on the board and start talking to the relay. */
  function enter() {
    active = true;
    loadChat();
    pending = null;
    incoming = null;
    homeVisible = false;
    el.homeCard.hidden = true;
    showState();
    el.onlineCard.hidden = false;
    renderChat();
    connect();
  }

  /* Drop the game on this device (the relay is not told; see leaveForGood). */
  function forget() {
    if (active) {
      disconnect();
      active = false;
      pending = null;
      incoming = null;
      app.setOnline(null);
      el.onlineCard.hidden = true;
      chat.items = [];
      setSheet(false);
      writeJson(CHAT_KEY, null);
      renderChat();
      document.title = baseTitle;
    }
    session = null;
    persist();
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
    boardFlags();
    app.loadGame(s ? s.moves.map(P.decodeMove) : []);
    renderCard();
  }

  /* Tell the board who we are, how the game stands and what we may ask for. */
  function boardFlags() {
    var s = session.state;
    var outcome = s && s.outcome ? P.outcomeText(s.outcome) : null;
    if (!outcome && session.peerLeft && !(s && P.gameOver(s))) outcome = 'Your opponent left the game';
    var mine = myColor();
    app.setOnline({
      color: mine,
      outcome: outcome,
      peerLeft: !!session.peerLeft,
      canTakeBack: !!s && !s.outcome && !session.peerLeft && !!mine && !!P.takebackPlies(s.moves, mine),
      peerName: peerName()
    });
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
      showHome(detail === 'daily-limit' ? dailyLimitText(null) : networkLimitText());
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
      addLine('sys', peerName() + ' left the game.');
      app.flash(peerName() + ' left the game.');
      nudge('Your opponent left');
    }
    var arrived = online && !peerOnline;
    peerOnline = online;
    // Every time the other side (re)appears, compare notes; this is also how
    // anything missed while one of us was offline gets caught up.
    if (online) {
      sendHello();
      sendSync();
    }
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
        handle(body, plain.n);
      })
      .catch(function (err) {
        console.warn('[online] ignored a message:', err && err.message);
      });
  }

  function handle(body, n) {
    if (body.t === 'sync') adopt(body.state, false);
    else if (body.t === 'move') receiveMove(body);
    else if (body.t === 'request') receiveRequest(body);
    else if (body.t === 'reply') receiveReply(body);
    else if (body.t === 'hello') receiveHello(body);
    else if (body.t === 'chat') receiveChat(body, n);
    else if (body.t === 'ack') receiveAck(body);
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
      boardFlags();
      renderCard();
      app.flash('Opponent played ' + played.san + '.');
      nudge('Your move');
    } else if (verdict === 'resync') {
      sendSync();
    } else if (verdict === 'reject') {
      console.warn('[online] refused a move from the other side', body);
    }
  }


  /* ---------------------------------------------------------------- chat */

  function sendHello() {
    send({ t: 'hello', name: myName(), caps: ['chat'] });
  }

  /* Who the other player says they are, sent over the sealed channel. */
  function receiveHello(body) {
    var name = Chat.cleanName(body.name);
    var earlier = session.peerName;
    var first = !session.peerHello;
    if (!session.peerVerified && earlier && name && earlier !== name) {
      addLine('sys', 'The invite said “' + earlier + '”, but they joined as “' + name + '”.');
    }
    session.peerName = name;
    session.peerVerified = true;
    session.peerHello = true;
    session.peerChat = Array.isArray(body.caps) && body.caps.indexOf('chat') !== -1;
    persist();
    if (first) addLine('sys', peerName() + ' joined.');
    if (currentPanel === 'invite' && peerOnline) {
      el.inviteStatus.textContent = peerName() + ' is here. Have a good game!';
    }
    boardFlags();
    renderCard();
    renderChat();
  }

  /* The allowance is per game: a rematch is a new game and starts fresh. */
  function chatCounts() {
    var game = session.state ? session.state.game : '';
    if (session.chatGame !== game) {
      session.chatGame = game;
      session.chatSent = 0;
      session.chatRecv = 0;
      persist();
    }
  }

  function loadChat() {
    var saved = readJson(CHAT_KEY);
    chat.items = saved && saved.id === session.seatToken ? Chat.validHistory(saved.items) : [];
    var now = Date.now();
    chat.bucket = Chat.freshBucket(now, CL.burst);
    chat.inBucket = Chat.freshBucket(now, CL.inboundBurst);
    chat.strikes = 0;
    chat.unread = 0;
  }

  function addLine(who, text, extra) {
    var item = { who: who, text: text };
    if (extra) item.n = extra.n;
    chat.items = Chat.addToHistory(chat.items, item);
    writeJson(CHAT_KEY, { id: session.seatToken, items: chat.items });
    renderChatLog(who);
    renderChatMeta();
  }

  /* Returns true if the message went out (the box can then be cleared). */
  function sendChat(raw) {
    if (!active || !session) return false;
    var text = Chat.cleanMessage(raw);
    if (!text) return false;
    var who = peerName();
    if (session.peerLeft) return chatNote(who + ' has left the game.');
    if (linkStatus !== 'connected' || !peerOnline) {
      return chatNote('Not delivered: ' + who + ' is offline. Chat is not saved for later.');
    }
    if (!session.peerChat) return chatNote(who + '’s version of Farboard does not support chat yet.');
    chatCounts();
    if (session.chatSent >= CL.sendCap) {
      return chatNote('Chat limit for this game reached (' + CL.sendCap + ' messages each). A rematch starts fresh.');
    }
    var bucket = Chat.takeToken(chat.bucket, Date.now(), CL.burst);
    if (!bucket) return chatNote('Slow down a little.');
    chat.bucket = bucket;
    session.chatSent += 1;
    persist();
    send({ t: 'chat', text: text });
    addLine('me', text, { n: session.sendN });
    return true;
  }

  function chatNote(text) {
    el.chatNote.textContent = text;
    return false;
  }

  /* The receiver enforces the limits too: the sender's app is not trusted. */
  function receiveChat(body, n) {
    if (session.chatMuted) return;
    chatCounts();
    if (session.chatRecv >= CL.sendCap) return;
    var bucket = Chat.takeToken(chat.inBucket, Date.now(), CL.inboundBurst);
    if (!bucket) {
      chat.strikes += 1;
      if (chat.strikes >= CL.strikes) {
        session.chatMuted = true;
        persist();
        addLine('sys', peerName() + ' was sending too fast, so chat is muted.');
      }
      return;
    }
    chat.inBucket = bucket;
    var text = Chat.cleanMessage(body.text);
    if (!text) return;
    session.chatRecv += 1;
    persist();
    addLine('peer', text);
    // Tells the sender it arrived; only messages we accepted are confirmed.
    if (typeof n === 'number') send({ t: 'ack', n: n });
    if (document.hidden || !chatSeen()) {
      chat.unread += 1;
      renderUnread();
      nudge(chat.unread === 1 ? 'New message' : chat.unread + ' new messages');
    }
  }

  /* The other side accepted our message number n. */
  function receiveAck(body) {
    var changed = false;
    chat.items.forEach(function (item) {
      if (item.who === 'me' && item.n === body.n && !item.ok) {
        item.ok = true;
        changed = true;
      }
    });
    if (!changed) return;
    writeJson(CHAT_KEY, { id: session.seatToken, items: chat.items });
    renderChatLog();
  }

  function toggleMute() {
    session.chatMuted = !session.chatMuted;
    if (!session.chatMuted) chat.strikes = 0;
    persist();
    renderChatMeta();
  }

  function renderChat() {
    var on = active && !!session;
    el.chatCard.hidden = !on;
    el.chatPeek.hidden = !on;
    if (!on) return;
    renderChatLog();
    renderChatMeta();
  }

  /* newWho: who a just-added line is from, or undefined when nothing was added. */
  function renderChatLog(newWho) {
    if (!active || !session) return;
    var log = el.chatLog;
    var atBottom = nearBottom();
    log.replaceChildren();
    if (!chat.items.length) {
      var empty = document.createElement('li');
      empty.className = 'chat-empty';
      empty.textContent = 'No messages yet.';
      log.appendChild(empty);
    }
    chat.items.forEach(function (item) {
      var line = document.createElement('li');
      if (item.who === 'sys') {
        line.className = 'chat-line sys';
        line.textContent = item.text;
      } else {
        line.className = 'chat-line ' + (item.who === 'me' ? 'mine' : 'theirs');
        var name = document.createElement('bdi');
        name.className = 'chat-name';
        name.textContent = (item.who === 'me' ? myName() || 'You' : peerName()) + ':';
        line.appendChild(name);
        line.appendChild(document.createTextNode(' ' + item.text));
        if (item.ok) {
          var tick = document.createElement('span');
          tick.className = 'chat-tick';
          tick.textContent = ' ✓';
          tick.title = 'Delivered';
          line.appendChild(tick);
        }
      }
      log.appendChild(line);
    });
    if (atBottom || newWho === 'me') log.scrollTop = log.scrollHeight;
    // Something new below while reading further up: offer a way down.
    else if (newWho === 'peer') el.chatNewBtn.hidden = false;
    renderPeek();
  }

  /* The bar under the board on phones: the latest message, and how many are unread. */
  function renderPeek() {
    var last = null;
    chat.items.forEach(function (item) {
      if (item.who !== 'sys') last = item;
    });
    el.chatPeekText.textContent = last
      ? (last.who === 'me' ? myName() || 'You' : peerName()) + ': ' + last.text
      : 'Chat';
    renderUnread();
  }

  function renderUnread() {
    [el.chatBadge, el.chatPeekBadge].forEach(function (badge) {
      badge.hidden = !chat.unread;
      badge.textContent = chat.unread;
    });
  }

  /* Mute button, whether the box can be used, and the line of small print. */
  function renderChatMeta() {
    if (!active || !session) return;
    var closed = !!session.peerLeft;
    el.chatMuteBtn.textContent = session.chatMuted ? 'Unmute' : 'Mute';
    el.chatMuteBtn.setAttribute('aria-pressed', session.chatMuted ? 'true' : 'false');
    el.chatInput.disabled = closed;
    el.chatSendBtn.disabled = closed;
    Array.prototype.forEach.call(el.chatChips.children, function (chip) {
      chip.disabled = closed;
    });
    chatCounts();
    var left = CL.sendCap - session.chatSent;
    var text = '';
    if (closed) text = 'Your opponent has left.';
    else if (session.peerHello && !session.peerChat) text = peerName() + '’s version does not support chat yet.';
    else if (session.chatMuted) text = 'Chat from ' + peerName() + ' is muted.';
    else if (left <= 20) text = left + ' message' + (left === 1 ? '' : 's') + ' left this game.';
    el.chatNote.textContent = text;
  }

  function nearBottom() {
    var log = el.chatLog;
    return log.scrollHeight - log.scrollTop - log.clientHeight < 40;
  }

  /* Is the chat in front of the reader: the card on a wide screen, the sheet on a phone. */
  function chatSeen() {
    return PHONE.matches ? chat.sheetOpen : chat.visible;
  }

  /* ---- the phone's sheet: it rises over the lower page, the board shrinks to stay clear */

  function fitSheet() {
    var vv = window.visualViewport;
    var height = vv ? vv.height : window.innerHeight;
    // How much of the screen the on-screen keyboard covers.
    var keyboard = vv ? Math.max(0, window.innerHeight - vv.height - vv.offsetTop) : 0;
    var root = document.documentElement.style;
    root.setProperty('--vvh', height + 'px');
    root.setProperty('--kb', keyboard + 'px');
    document.body.classList.toggle('keyboard-up', keyboard > 100);
    // Measured after the keyboard class, which changes the sheet's height.
    root.setProperty('--sheet-h', el.chatCard.offsetHeight + 'px');
  }

  function setSheet(open) {
    open = open && PHONE.matches && active;
    chat.sheetOpen = open;
    document.body.classList.toggle('chat-open', open);
    if (!open) document.body.classList.remove('keyboard-up');
    el.chatPeek.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) {
      fitSheet();
      window.scrollTo(0, 0);
      el.chatLog.scrollTop = el.chatLog.scrollHeight;
      el.chatNewBtn.hidden = true;
      el.chatCloseBtn.focus({ preventScroll: true });
    } else if (document.activeElement && el.chatCard.contains(document.activeElement)) {
      document.activeElement.blur();
      el.chatPeek.focus({ preventScroll: true });
    }
    seenChat();
  }

  function seenChat() {
    if (chatSeen() && !document.hidden && chat.unread) {
      chat.unread = 0;
      renderUnread();
    }
  }

  function bindChat() {
    Chat.QUICK_REPLIES.forEach(function (text) {
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'btn small';
      chip.textContent = text;
      chip.addEventListener('click', function () {
        sendChat(text);
      });
      el.chatChips.appendChild(chip);
    });
    el.chatForm.addEventListener('submit', function (event) {
      event.preventDefault();
      if (sendChat(el.chatInput.value)) el.chatInput.value = '';
      el.chatInput.focus({ preventScroll: true });
    });
    // Esc leaves the box; it must not also clear the board's selection.
    el.chatCard.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        if (chat.sheetOpen) setSheet(false);
        else el.chatInput.blur();
      }
    });
    on(el.chatMuteBtn, toggleMute);
    on(el.chatPeek, function () {
      setSheet(!chat.sheetOpen);
    });
    // Esc closes the sheet from anywhere, not only while focus is inside it.
    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape' && chat.sheetOpen) setSheet(false);
    });
    on(el.chatCloseBtn, function () {
      setSheet(false);
    });
    on(el.chatNewBtn, function () {
      el.chatLog.scrollTop = el.chatLog.scrollHeight;
      el.chatNewBtn.hidden = true;
    });
    el.chatLog.addEventListener('scroll', function () {
      if (nearBottom()) el.chatNewBtn.hidden = true;
    });
    // The keyboard and rotation change the room the sheet has.
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', function () {
        if (chat.sheetOpen) fitSheet();
      });
    }
    PHONE.addEventListener('change', function () {
      setSheet(false);
    });
    if (window.IntersectionObserver) {
      new IntersectionObserver(
        function (entries) {
          chat.visible = entries[entries.length - 1].isIntersecting;
          seenChat();
        },
        { threshold: 0.5 }
      ).observe(el.chatCard);
    }
    document.addEventListener('visibilitychange', seenChat);
  }

  /* ------------------------------------------------------------ requests */

  var REQUEST_TEXT = {
    takeback: 'Your opponent asks to take back their last move.',
    draw: 'Your opponent offers a draw.',
    newgame: 'Your opponent asks for a rematch (colours swap).'
  };
  var ASKED_TEXT = {
    takeback: 'Asked to take back your move…',
    draw: 'Offered a draw…',
    newgame: 'Asked for a rematch…'
  };
  var ACCEPTED_TEXT = {
    takeback: 'Move taken back.',
    draw: 'Draw agreed.',
    newgame: 'Rematch on.'
  };
  var DECLINED_TEXT = {
    takeback: 'Your opponent declined the take-back.',
    draw: 'Your opponent declined the draw.',
    newgame: 'Your opponent declined a rematch.'
  };

  /* Ask the other side (take-back, draw or new game). */
  function request(kind) {
    if (!active || !session || !session.state) return;
    if (session.peerLeft) {
      // Nobody to ask. A new game means a new invite.
      if (kind !== 'newgame') return app.flash('Your opponent has left this game.');
      leaveForGood();
      return showHome();
    }
    var s = session.state;
    if (!peerOnline) return app.flash('Your opponent is not connected right now.');
    if (pending) return app.flash('Still waiting for an answer to your last request.');
    if (kind === 'takeback' && (s.outcome || !P.takebackPlies(s.moves, myColor()))) {
      return app.flash('There is no move of yours to take back.');
    }
    if (kind === 'draw' && P.gameOver(s)) return app.flash('The game is already over.');
    // Rematches are offered once a game is over; until then, resign first.
    if (kind === 'newgame' && !P.gameOver(s)) return app.flash('Finish or resign this game first.');
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
    app.flash(REQUEST_TEXT[body.kind]);
    // On a phone the answer buttons sit below the board; bring them into view.
    if (window.matchMedia('(max-width: 860px)').matches) {
      el.requestBanner.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
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
    boardFlags();
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

    // Once the game is over the board's overlay offers what comes next.
    el.playButtons.hidden = over || !!session.peerLeft;
    el.drawBtn.disabled = !color || !peerOnline || !!pending;
    el.resignBtn.disabled = !color;
    el.reconnectBtn.hidden = linkStatus !== 'stopped';
    el.inviteAgainBtn.hidden = session.role !== 'host' || !!session.peerLeft || over;
    el.leaveBtn.textContent = session.peerLeft || over ? 'Close game' : 'Leave game';
  }

  /* Leave the game for good and go home; mid-game, only once confirmed. */
  function leaveGame() {
    var s = session && session.state;
    var settled = !s || session.peerLeft || P.gameOver(s);
    if (!settled && !window.confirm('Leave this game for good? You will not be able to rejoin it.')) return;
    leaveForGood();
    showHome();
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

  /*
   * The home card, shown whenever there is no game: host one, or how to join.
   * message: shown in the hosting section, e.g. why a game was refused.
   */
  function showHome(message) {
    // A dialog left open, such as the invite for a game the relay just
    // refused, would hide the reason and offer a link that no longer works.
    closeModal();
    homeVisible = true;
    el.homeCard.hidden = false;
    el.hostError.textContent = typeof message === 'string' ? message : '';
    el.hostNameInput.value = el.hostNameInput.value || savedName();
    el.hostChecking.hidden = false;
    el.hostReady.hidden = true;
    el.hostOwnerOnly.hidden = true;
    el.hostSetupNeeded.hidden = true;
    findHouse().then(renderHosting);
  }

  /* The hosting part of the home card, once we know which relay this site has. */
  function renderHosting() {
    if (!homeVisible) return;
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
        if (!homeVisible) return;
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
    var picked = el.homeCard.querySelector('input[name="hostColor"]:checked');
    var value = picked ? picked.value : 'w';
    if (value === 'random') return Math.random() < 0.5 ? 'w' : 'b';
    return value;
  }

  function hostGame() {
    var hosting = hostingRelay();
    if (!hosting) return showHome();
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
      state: P.newState(C.randomToken(9), describeHostColor()),
      name: rememberName(el.hostNameInput.value),
      peerName: '',
      peerVerified: false
    };
    persist();
    enter();
    showInvite();
  }

  function showInvite() {
    if (!session) return;
    var link = P.inviteLink(pageBase(), session.secret, session.relay, session.name);
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
    link.name = Chat.cleanName(link.name || '');
    pendingJoin = link;
    el.joinWho.textContent = (link.name || 'Someone') + ' would like to play.';
    el.joinNameInput.value = savedName();
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
      state: null,
      name: rememberName(el.joinNameInput.value),
      peerName: link.name,
      peerVerified: false
    };
    persist();
    closeModal();
    enter();
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
      'homeCard',
      'onlineCard',
      'netDot',
      'netStatus',
      'netDetail',
      'requestBanner',
      'requestText',
      'requestButtons',
      'requestAccept',
      'requestDecline',
      'playButtons',
      'drawBtn',
      'resignBtn',
      'reconnectBtn',
      'inviteAgainBtn',
      'leaveBtn',
      'onlineTitle',
      'onlineClose',
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
      'joinCancelBtn',
      'hostNameInput',
      'joinWho',
      'joinNameInput',
      'chatCard',
      'chatBadge',
      'chatMuteBtn',
      'chatLog',
      'chatChips',
      'chatForm',
      'chatInput',
      'chatSendBtn',
      'chatCloseBtn',
      'chatNewBtn',
      'chatNote',
      'chatPeek',
      'chatPeekText',
      'chatPeekBadge'
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
    on(el.onlineClose, closeModal);
    el.modal.addEventListener('click', function (event) {
      if (event.target === el.modal) closeModal();
    });
    // Keys typed in the dialog are the dialog's, not the board's shortcuts.
    el.modal.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') closeModal();
      event.stopPropagation();
    });

    // Home
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

    // Get your own copy
    on(el.copyKeyBtn, function () {
      app.copyText(el.draftKeyInput.value, 'Owner key');
    });
    on(el.openCopyBtn, openCopyTarget);
    el.copyAddressInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') openCopyTarget();
    });
    on(el.copyBackBtn, closeModal);

    // Owner key
    on(el.checkRelayBtn, checkRelay);
    el.ownerKeyInput.addEventListener('keydown', function (event) {
      if (event.key === 'Enter') checkRelay();
    });
    on(el.setupBackBtn, function () {
      closeModal();
      // A key saved or forgotten there may change where this device can host.
      if (homeVisible) renderHosting();
    });
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
    on(el.leaveBtn, leaveGame);

    bindChat();
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
    if (session) enter();
    else showHome();
    readAddressBar();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
