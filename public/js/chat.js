/*
 * chat.js — the rules of in-game chat: what a name or message may look like,
 * and how much of it one player may send.
 *
 * Pure functions only, no sockets, storage or DOM, so all of it can be tested
 * in Node. online.js does the talking. Chat rides the same sealed channel as
 * moves, so the relay cannot read it or tell it from a move, which is why
 * every limit here is enforced by the devices themselves: by the sender to be
 * polite, and by the receiver because it cannot trust the sender to be.
 */
(function (root) {
  'use strict';

  var LIMITS = {
    nameMax: 20, // characters (code points) in a name
    textMax: 280, // characters in a message
    sendCap: 150, // messages one player may send per game (a rematch starts a new game)
    historyMax: 100, // messages kept and shown on a device
    burst: 5, // messages that may go out back to back
    refillMs: 1000, // then one more every second
    inboundBurst: 8, // a little looser, so honest lag never trips it
    strikes: 5 // rejected bursts from the other side before chat is muted
  };

  var QUICK_REPLIES = ['👍', 'Good luck!', 'Good game', 'One sec…'];

  // Names that would pass for the app itself, or for the reader.
  var RESERVED = ['you', 'me', 'system', 'farboard', 'opponent', 'admin'];

  var CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
  // Zero-width and direction-changing characters; joiners for emoji are kept.
  var INVISIBLES = /[\u00AD\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

  function chars(text) {
    return Array.from(text);
  }

  /* A line of text made safe to show: one line, no hidden characters, cut to `max`. */
  function cleanText(value, max) {
    if (typeof value !== 'string') return '';
    var text = value.normalize('NFC').replace(CONTROLS, ' ').replace(INVISIBLES, '');
    text = text.replace(/\s+/g, ' ').trim();
    var list = chars(text);
    return list.length > max ? list.slice(0, max).join('').trim() : text;
  }

  /* A player's name, or '' if there is nothing usable (the caller then says "Opponent"). */
  function cleanName(value) {
    var name = cleanText(value, LIMITS.nameMax);
    return RESERVED.indexOf(name.toLowerCase()) !== -1 ? '' : name;
  }

  function cleanMessage(value) {
    return cleanText(value, LIMITS.textMax);
  }

  /* How to call the other player; never the same as our own name. */
  function peerLabel(peerName, myName) {
    var name = peerName || 'Opponent';
    if (myName && name.toLowerCase() === myName.toLowerCase()) return name + ' (opponent)';
    return name;
  }

  /* --------------------------------------------------------- rate limiting */

  function freshBucket(now, capacity) {
    return { tokens: capacity, at: now };
  }

  /* Spend one token. Returns the new bucket, or null if it is empty. */
  function takeToken(bucket, now, capacity) {
    var elapsed = Math.max(0, now - bucket.at);
    var tokens = Math.min(capacity, bucket.tokens + elapsed / LIMITS.refillMs);
    if (tokens < 1) return null;
    return { tokens: tokens - 1, at: now };
  }

  /* ---------------------------------------------------------------- history */

  function addToHistory(items, item) {
    var next = items.concat([item]);
    return next.length > LIMITS.historyMax ? next.slice(next.length - LIMITS.historyMax) : next;
  }

  /* Saved history read back from storage, checked before anything shows it. */
  function validHistory(items) {
    if (!Array.isArray(items)) return [];
    return items
      .filter(function (item) {
        return (
          item &&
          typeof item === 'object' &&
          (item.who === 'me' || item.who === 'peer' || item.who === 'sys') &&
          typeof item.text === 'string' &&
          item.text.length > 0 &&
          item.text.length <= LIMITS.textMax * 2
        );
      })
      .map(function (item) {
        var clean = { who: item.who, text: cleanText(item.text, LIMITS.textMax) };
        // Our own messages remember which of them the other side confirmed.
        if (item.who === 'me' && typeof item.n === 'number') clean.n = item.n;
        if (item.who === 'me' && item.ok === true) clean.ok = true;
        return clean;
      })
      .filter(function (item) {
        return item.text;
      })
      .slice(-LIMITS.historyMax);
  }

  var api = {
    LIMITS: LIMITS,
    QUICK_REPLIES: QUICK_REPLIES,
    cleanText: cleanText,
    cleanName: cleanName,
    cleanMessage: cleanMessage,
    peerLabel: peerLabel,
    freshBucket: freshBucket,
    takeToken: takeToken,
    addToHistory: addToHistory,
    validHistory: validHistory
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.ChatRules = api;
})(typeof window !== 'undefined' ? window : globalThis);
