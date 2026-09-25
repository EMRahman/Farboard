/*
 * relayclient.js — one seat's connection to a relay.
 *
 * Phones are hard on long-lived connections: the screen locks, the tab is
 * frozen, Wi-Fi hands over to mobile data. This keeps trying (backing off up
 * to 30 seconds), retries straight away when the page becomes visible or the
 * network comes back, and treats a socket that does not answer a ping as
 * dead even if the browser still thinks it is open.
 *
 * Pings cost the relay's daily allowance, so they are sparing: one every 50
 * seconds while the page is visible, none while it is hidden, and one
 * straight away when it is shown again to check the line still works.
 *
 * Frames from the relay itself are JSON ('joined', 'peer'); frames from the
 * other player are sealed base64url strings and are handed on untouched.
 */
(function (root) {
  'use strict';

  var P = root.ChessProtocol;

  var PING_MS = 50 * 1000;
  var REPLY_MS = 10 * 1000;
  var MAX_BACKOFF_MS = 30 * 1000;

  // Close codes after which retrying cannot help (see relay/src/rules.js).
  var FATAL = {
    4400: 'bad-request',
    4401: 'no-game',
    4403: 'full',
    4409: 'replaced',
    4410: 'expired',
    4411: 'left',
    4430: 'network-limit',
    4503: 'daily-limit',
    4508: 'room-limit'
  };

  /*
   * options: relay (origin), roomId, seatToken, create (host only: may open
   *          the room), ownerKey (host on their own relay),
   *          onStatus(status, detail), onPeer(online, left), onFrame(frame)
   *          (left: the other player has left the game for good)
   * status:  'connecting' | 'connected' | 'reconnecting' | 'stopped'
   */
  function RelayClient(options) {
    this.options = options;
    this.socket = null;
    this.joined = false;
    this.stopped = false;
    this.attempt = 0;
    this.retryTimer = null;
    this.pingTimer = null;
    this.replyTimer = null;
    this.awaitingSince = 0; // when we pinged and have heard nothing since

    var self = this;
    this.wake = function () {
      if (self.stopped || document.visibilityState === 'hidden') return;
      if (self.joined) self.ping();
      else if (!self.socket) self.connect();
    };
    root.addEventListener('online', this.wake);
    document.addEventListener('visibilitychange', this.wake);
  }

  RelayClient.prototype.connect = function () {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.status(this.attempt ? 'reconnecting' : 'connecting');

    var self = this;
    var ws;
    try {
      ws = new WebSocket(P.socketUrl(this.options.relay, this.options.roomId));
    } catch (err) {
      this.retry();
      return;
    }
    this.socket = ws;

    ws.onopen = function () {
      var hello = { t: 'join', seatToken: self.options.seatToken };
      if (self.options.create) hello.create = true;
      if (self.options.ownerKey) hello.ownerKey = self.options.ownerKey;
      ws.send(JSON.stringify(hello));
    };

    ws.onmessage = function (event) {
      if (ws !== self.socket || typeof event.data !== 'string') return;
      self.awaitingSince = 0;
      var data = event.data;
      if (data === 'pong') return;
      if (data.charAt(0) !== '{') {
        self.options.onFrame(data);
        return;
      }
      var note;
      try {
        note = JSON.parse(data);
      } catch (err) {
        return;
      }
      if (note.t === 'joined') {
        self.joined = true;
        self.attempt = 0;
        self.startPing();
        self.status('connected');
        self.options.onPeer(!!note.peer, !!note.peerLeft);
      } else if (note.t === 'peer') {
        self.options.onPeer(!!note.online, !!note.left);
      }
    };

    ws.onclose = function (event) {
      if (ws !== self.socket) return;
      self.dropSocket();
      var fatal = FATAL[event.code];
      if (fatal) {
        self.stop();
        self.status('stopped', fatal);
      } else {
        self.retry();
      }
    };
  };

  RelayClient.prototype.retry = function () {
    if (this.stopped) return;
    this.attempt++;
    var backoff = Math.min(MAX_BACKOFF_MS, 1000 * Math.pow(2, this.attempt - 1));
    var delay = Math.round(backoff * (0.5 + Math.random() * 0.5));
    this.status('reconnecting', { retryInMs: delay });
    var self = this;
    this.retryTimer = setTimeout(function () {
      self.connect();
    }, delay);
  };

  RelayClient.prototype.startPing = function () {
    var self = this;
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(function () {
      if (document.visibilityState !== 'hidden') self.ping();
    }, PING_MS);
  };

  /* Ping; if nothing at all comes back within REPLY_MS, start a new socket. */
  RelayClient.prototype.ping = function () {
    if (!this.joined || !this.socket) return;
    if (this.awaitingSince) {
      if (Date.now() - this.awaitingSince > REPLY_MS) this.restart();
      return;
    }
    this.awaitingSince = Date.now();
    try {
      this.socket.send('ping');
    } catch (err) {
      /* onclose will follow */
    }
    var self = this;
    clearTimeout(this.replyTimer);
    this.replyTimer = setTimeout(function () {
      if (self.awaitingSince && Date.now() - self.awaitingSince >= REPLY_MS) self.restart();
    }, REPLY_MS + 100);
  };

  /* Give up on a socket that has gone quiet and open a new one. */
  RelayClient.prototype.restart = function () {
    var dead = this.socket;
    this.dropSocket();
    if (dead) {
      dead.onclose = null;
      try {
        dead.close();
      } catch (err) {
        /* already gone */
      }
    }
    this.attempt = 0;
    this.connect();
  };

  RelayClient.prototype.dropSocket = function () {
    this.socket = null;
    this.joined = false;
    this.awaitingSince = 0;
    clearInterval(this.pingTimer);
    clearTimeout(this.replyTimer);
  };

  /* Send a sealed frame. False if not connected; the next sync catches up. */
  RelayClient.prototype.send = function (frame) {
    if (!this.joined || !this.socket || this.socket.readyState !== 1) return false;
    this.socket.send(frame);
    return true;
  };

  /* Tell the relay this player is leaving the game for good, then hang up. */
  RelayClient.prototype.leave = function () {
    if (!this.joined || !this.socket) return false;
    // Queued data goes out before the close handshake, so this arrives first.
    this.socket.send(JSON.stringify({ t: 'leave' }));
    this.stop();
    return true;
  };

  RelayClient.prototype.stop = function () {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    root.removeEventListener('online', this.wake);
    document.removeEventListener('visibilitychange', this.wake);
    var ws = this.socket;
    this.dropSocket();
    if (ws) {
      ws.onclose = null;
      try {
        ws.close(1000);
      } catch (err) {
        /* already gone */
      }
    }
  };

  RelayClient.prototype.status = function (status, detail) {
    this.options.onStatus(status, detail || null);
  };

  root.RelayClient = RelayClient;
})(window);
