/*
 * protocol.js — what two devices say to each other in an online game.
 *
 * Pure functions only: no sockets, no storage, no DOM. The online controller
 * (online.js) does the talking; this file decides what a message means and
 * whether to believe it, so all of that can be tested in Node.
 *
 * The shared game state both sides keep:
 *
 *   { game, rev, hostColor, moves, outcome }
 *
 *   game       id of the current game; a new game gets a new id.
 *   rev        bumped by every change that is not simply "one more move":
 *              an accepted take-back, an agreed draw, a resignation, a new
 *              game. The higher revision always wins, which is what makes a
 *              take-back stick even if an older copy of the game turns up.
 *   hostColor  'w' or 'b'; the guest plays the other colour.
 *   moves      coordinate strings like 'e2e4' or 'e7e8q'.
 *   outcome    null, or { winner: 'w' | 'b' | null, reason } for results
 *              the board cannot show by itself (resignation, agreed draw).
 *
 * Every message is { from, n, body } sealed with the game key. `from` is the
 * sender's role and `n` a counter that only goes up, so a message cannot be
 * reflected back at its sender or replayed later by the relay.
 */
(function (root) {
  'use strict';

  var Chess =
    root.ChessEngine && root.ChessEngine.Chess ? root.ChessEngine.Chess : require('./chess.js').Chess;

  var PROTO = 1;
  var MAX_PLIES = 6000; // longer than any legal game can run
  var MOVE_PATTERN = /^[a-h][1-8][a-h][1-8][qrbn]?$/;
  var TOKEN_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
  var REQUEST_KINDS = ['takeback', 'draw', 'newgame'];

  /* ---------------------------------------------------------------- moves */

  function encodeMove(move) {
    return move.from + move.to + (move.promotion || '');
  }

  function decodeMove(text) {
    if (typeof text !== 'string' || !MOVE_PATTERN.test(text)) return null;
    var move = { from: text.slice(0, 2), to: text.slice(2, 4) };
    if (text.length === 5) move.promotion = text[4];
    return move;
  }

  function otherColor(color) {
    return color === 'w' ? 'b' : 'w';
  }

  function colorFor(role, hostColor) {
    return role === 'host' ? hostColor : otherColor(hostColor);
  }

  /*
   * Play the moves out on a fresh board. Returns { game, colors } — colors[i]
   * is the side that played moves[i] — or null if any move is illegal or not
   * written the way encodeMove would write it.
   */
  function replay(moves) {
    var game = new Chess();
    var colors = [];
    for (var i = 0; i < moves.length; i++) {
      var request = decodeMove(moves[i]);
      if (!request) return null;
      var mover = game.turn();
      var played = game.move(request);
      if (!played || encodeMove(played) !== moves[i]) return null;
      colors.push(mover);
    }
    return { game: game, colors: colors };
  }

  /* ---------------------------------------------------------------- state */

  function newState(gameId, hostColor) {
    return { game: gameId, rev: 0, hostColor: hostColor, moves: [], outcome: null };
  }

  function copyState(state) {
    return {
      game: state.game,
      rev: state.rev,
      hostColor: state.hostColor,
      moves: state.moves.slice(),
      outcome: state.outcome ? { winner: state.outcome.winner, reason: state.outcome.reason } : null
    };
  }

  function isToken(value) {
    return typeof value === 'string' && TOKEN_PATTERN.test(value);
  }

  function isCount(value) {
    return typeof value === 'number' && value >= 0 && Math.floor(value) === value;
  }

  function validOutcome(outcome) {
    if (outcome === null) return true;
    return (
      !!outcome &&
      typeof outcome === 'object' &&
      (outcome.winner === 'w' || outcome.winner === 'b' || outcome.winner === null) &&
      (outcome.reason === 'resignation' || outcome.reason === 'agreement')
    );
  }

  /* A state received from the other side, checked before anything trusts it. */
  function validState(state) {
    return (
      !!state &&
      typeof state === 'object' &&
      isToken(state.game) &&
      isCount(state.rev) &&
      (state.hostColor === 'w' || state.hostColor === 'b') &&
      Array.isArray(state.moves) &&
      state.moves.length <= MAX_PLIES &&
      validOutcome(state.outcome) &&
      replay(state.moves) !== null
    );
  }

  function sameMoves(a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function isPrefix(shorter, longer) {
    if (shorter.length > longer.length) return false;
    for (var i = 0; i < shorter.length; i++) if (shorter[i] !== longer[i]) return false;
    return true;
  }

  function sameOutcome(a, b) {
    if (!a || !b) return a === b;
    return a.winner === b.winner && a.reason === b.reason;
  }

  /*
   * Reconcile our state with one the other side sent. Returns
   *
   *   { state, changed, sendBack, notice }
   *
   *   changed   our state was replaced; redraw the board.
   *   sendBack  they are missing something we have; send them our state.
   *   notice    null, 'reset' (a take-back, draw, resignation or new game
   *             we had not heard about), 'diverged' (the two copies
   *             disagreed and the host's was kept) or 'rejected'.
   *
   * Both sides run this on every sync and they converge: whoever is behind
   * adopts, whoever is ahead sends back, and neither sends back after
   * adopting, so it cannot ping-pong.
   */
  function mergeState(mine, theirs, iAmHost) {
    if (theirs === null) return result(mine, false, !!mine, null);
    if (!validState(theirs)) return result(mine, false, false, 'rejected');
    if (!mine) return result(copyState(theirs), true, false, null);

    if (theirs.rev > mine.rev) return result(copyState(theirs), true, false, 'reset');
    if (theirs.rev < mine.rev) return result(mine, false, true, null);

    var sameGame =
      theirs.game === mine.game &&
      theirs.hostColor === mine.hostColor &&
      sameOutcome(theirs.outcome, mine.outcome);

    if (sameGame && isPrefix(theirs.moves, mine.moves)) {
      return result(mine, false, mine.moves.length > theirs.moves.length, null);
    }

    if (sameGame && isPrefix(mine.moves, theirs.moves)) {
      // Each side stores its own move before sending it, so the only moves
      // we can be missing are the other side's. Anything else is refused.
      var peer = otherColor(colorFor(iAmHost ? 'host' : 'guest', mine.hostColor));
      var colors = replay(theirs.moves).colors.slice(mine.moves.length);
      var onlyTheirs = colors.every(function (color) {
        return color === peer;
      });
      if (!onlyTheirs) return result(mine, false, false, 'rejected');
      return result(copyState(theirs), true, false, null);
    }

    // Same revision but the copies disagree. Not expected in normal play; the
    // host's copy is the tie-breaker so both sides end up on one game.
    if (iAmHost) return result(mine, false, true, 'diverged');
    return result(copyState(theirs), true, false, 'diverged');
  }

  function result(state, changed, sendBack, notice) {
    return { state: state, changed: changed, sendBack: sendBack, notice: notice };
  }

  /*
   * What to do with a move message from the other side:
   *   'apply'      it is the next move, played by them, and legal
   *   'duplicate'  we already have it
   *   'resync'     we are out of step; exchange states
   *   'reject'     illegal, or not theirs to play
   */
  function checkMove(state, body, peerColor) {
    if (!state || body.rev !== state.rev) return 'resync';
    if (state.outcome) return 'reject';
    if (body.ply < state.moves.length) {
      return state.moves[body.ply] === body.m ? 'duplicate' : 'resync';
    }
    if (body.ply > state.moves.length) return 'resync';

    var played = replay(state.moves);
    if (!played || played.game.turn() !== peerColor) return 'reject';
    var move = played.game.move(decodeMove(body.m));
    return move && encodeMove(move) === body.m ? 'apply' : 'reject';
  }

  /*
   * How many plies an accepted take-back removes: just the requester's last
   * move if the opponent has not replied yet, otherwise the reply as well so
   * it is the requester's turn again. 0 if they have not moved at all.
   */
  function takebackPlies(moves, requesterColor) {
    var played = replay(moves);
    if (!played) return 0;
    var colors = played.colors;
    var n = colors.length;
    if (n >= 1 && colors[n - 1] === requesterColor) return 1;
    if (n >= 2 && colors[n - 2] === requesterColor) return 2;
    return 0;
  }

  function gameOver(state) {
    if (state.outcome) return true;
    var played = replay(state.moves);
    return !!played && played.game.isGameOver();
  }

  function bumped(state) {
    var next = copyState(state);
    next.rev = state.rev + 1;
    return next;
  }

  /*
   * The state that results from accepting the other side's request, or null
   * if the request cannot be granted in this position (the accepting device
   * then declines it automatically).
   */
  function resolveRequest(state, kind, id, requesterColor) {
    var next;
    if (kind === 'takeback') {
      if (state.outcome) return null;
      var plies = takebackPlies(state.moves, requesterColor);
      if (!plies) return null;
      next = bumped(state);
      next.moves = state.moves.slice(0, state.moves.length - plies);
      return next;
    }
    if (kind === 'draw') {
      if (gameOver(state)) return null;
      next = bumped(state);
      next.outcome = { winner: null, reason: 'agreement' };
      return next;
    }
    if (kind === 'newgame') {
      if (!isToken(id)) return null;
      // Colours swap for each new game, the usual courtesy between friends.
      return {
        game: id,
        rev: state.rev + 1,
        hostColor: otherColor(state.hostColor),
        moves: [],
        outcome: null
      };
    }
    return null;
  }

  function resign(state, color) {
    if (gameOver(state)) return null;
    var next = bumped(state);
    next.outcome = { winner: otherColor(color), reason: 'resignation' };
    return next;
  }

  function outcomeText(outcome) {
    if (!outcome) return '';
    if (outcome.winner === null) return 'Draw agreed';
    var winner = outcome.winner === 'w' ? 'White' : 'Black';
    var loser = outcome.winner === 'w' ? 'Black' : 'White';
    return loser + ' resigned — ' + winner + ' wins';
  }

  /* ------------------------------------------------------------- messages */

  function validBody(body) {
    if (!body || typeof body !== 'object') return false;
    switch (body.t) {
      case 'sync':
        return body.state === null || typeof body.state === 'object';
      case 'move':
        return isCount(body.rev) && isCount(body.ply) && decodeMove(body.m) !== null;
      case 'request':
        return isToken(body.id) && REQUEST_KINDS.indexOf(body.kind) !== -1;
      case 'reply':
        return (
          isToken(body.id) &&
          typeof body.accept === 'boolean' &&
          (body.state === undefined || typeof body.state === 'object')
        );
      default:
        return false;
    }
  }

  function wrap(role, n, body) {
    return { v: PROTO, from: role, n: n, body: body };
  }

  /*
   * The body of a decrypted message, or null if it should be ignored: sent
   * by our own role (reflected), not newer than the last one we accepted
   * (replayed), or malformed.
   */
  function unwrap(plain, myRole, lastSeen) {
    if (!plain || typeof plain !== 'object' || plain.v !== PROTO) return null;
    var peerRole = myRole === 'host' ? 'guest' : 'host';
    if (plain.from !== peerRole) return null;
    if (!isCount(plain.n) || plain.n <= lastSeen) return null;
    return validBody(plain.body) ? plain.body : null;
  }

  /* ---------------------------------------------------------------- links */

  /*
   * A relay address as typed or pasted, reduced to its origin. HTTPS only,
   * apart from plain HTTP to this machine for development. Null if unusable.
   */
  function normalizeRelay(input) {
    var text = String(input || '').trim();
    if (!text) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'https://' + text;
    var url;
    try {
      url = new URL(text);
    } catch (err) {
      return null;
    }
    if (url.username || url.password) return null;
    var local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return url.origin;
  }

  /* How a relay is shown and put in links: no scheme when it is HTTPS. */
  function relayLabel(origin) {
    return origin.replace(/^https:\/\//, '');
  }

  function socketUrl(origin, roomId) {
    return origin.replace(/^http/, 'ws') + '/v1/rooms/' + roomId;
  }

  function inviteLink(base, secret, relayOrigin) {
    return base + '#join=' + secret + '&relay=' + encodeURIComponent(relayLabel(relayOrigin));
  }

  function setupLink(base, relayOrigin, ownerKey) {
    return (
      base +
      '#relay-setup=' +
      encodeURIComponent(relayLabel(relayOrigin)) +
      '&key=' +
      encodeURIComponent(ownerKey)
    );
  }

  function isOwnerKey(value) {
    return typeof value === 'string' && value.length >= 16 && value.length <= 256;
  }

  /*
   * Read an invite or setup link from location.hash (or a whole pasted URL).
   * Returns { join: { secret, relay } }, { setup: { relay, key } } or null.
   */
  function parseLink(text) {
    var hashAt = String(text || '').indexOf('#');
    if (hashAt === -1) return null;
    var params = new URLSearchParams(String(text).slice(hashAt + 1));
    var relay = normalizeRelay(params.get('relay') || params.get('relay-setup'));
    if (!relay) return null;

    if (params.has('join')) {
      var secret = params.get('join');
      return /^[A-Za-z0-9_-]{22}$/.test(secret) ? { join: { secret: secret, relay: relay } } : null;
    }
    if (params.has('relay-setup')) {
      var key = params.get('key');
      return isOwnerKey(key) ? { setup: { relay: relay, key: key } } : null;
    }
    return null;
  }

  var api = {
    PROTO: PROTO,
    encodeMove: encodeMove,
    decodeMove: decodeMove,
    otherColor: otherColor,
    colorFor: colorFor,
    replay: replay,
    newState: newState,
    copyState: copyState,
    validState: validState,
    sameMoves: sameMoves,
    mergeState: mergeState,
    checkMove: checkMove,
    takebackPlies: takebackPlies,
    gameOver: gameOver,
    resolveRequest: resolveRequest,
    resign: resign,
    outcomeText: outcomeText,
    isToken: isToken,
    validBody: validBody,
    wrap: wrap,
    unwrap: unwrap,
    normalizeRelay: normalizeRelay,
    relayLabel: relayLabel,
    socketUrl: socketUrl,
    inviteLink: inviteLink,
    setupLink: setupLink,
    isOwnerKey: isOwnerKey,
    parseLink: parseLink
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.ChessProtocol = api;
})(typeof window !== 'undefined' ? window : globalThis);
