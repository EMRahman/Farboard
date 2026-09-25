/*
 * netcrypto.js — the secrets behind an online game.
 *
 * An invite carries one random secret. Both devices derive two things from
 * it: the room id the relay knows the game by, and the AES-GCM key every
 * message is sealed with. The relay only ever sees the room id and
 * ciphertext, so it can pass moves along but never read or alter them.
 *
 * Works in the browser and in Node (both expose Web Crypto on globalThis).
 */
(function (root) {
  'use strict';

  var SALT = 'farboard-v1';
  var IV_BYTES = 12;
  var TAG_BYTES = 16;
  var SECRET_PATTERN = /^[A-Za-z0-9_-]{22}$/;

  var encoder = new TextEncoder();
  var decoder = new TextDecoder();

  function subtle() {
    if (!root.crypto || !root.crypto.subtle) {
      throw new Error('Web Crypto is not available (the page must be served over HTTPS).');
    }
    return root.crypto.subtle;
  }

  function toBase64Url(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text)) {
      throw new Error('Not base64url');
    }
    var base64 = text.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    var binary = atob(base64);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  /* A random base64url string carrying `bytes` bytes of entropy. */
  function randomToken(bytes) {
    var buffer = new Uint8Array(bytes);
    root.crypto.getRandomValues(buffer);
    return toBase64Url(buffer);
  }

  /* 128 bits: the invite secret. It only ever travels in a URL fragment. */
  function newSecret() {
    return randomToken(16);
  }

  function isSecret(text) {
    return typeof text === 'string' && SECRET_PATTERN.test(text);
  }

  function hkdf(info) {
    return { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(SALT), info: encoder.encode(info) };
  }

  /*
   * Resolves to { roomId, key }. The same secret always gives the same room
   * id and key, which is how two devices that share nothing but the invite
   * end up in the same room, able to read each other's messages.
   */
  function deriveRoom(secret) {
    if (!isSecret(secret)) return Promise.reject(new Error('Invalid invite secret'));
    var s = subtle();
    return s
      .importKey('raw', fromBase64Url(secret), 'HKDF', false, ['deriveBits', 'deriveKey'])
      .then(function (base) {
        return Promise.all([
          s.deriveBits(hkdf('room'), base, 256),
          s.deriveKey(hkdf('key'), base, { name: 'AES-GCM', length: 256 }, false, [
            'encrypt',
            'decrypt'
          ])
        ]);
      })
      .then(function (parts) {
        return { roomId: toBase64Url(new Uint8Array(parts[0])), key: parts[1] };
      });
  }

  /* Encrypt a JSON-able value. Output: base64url(iv | ciphertext+tag). */
  function seal(key, value) {
    var iv = new Uint8Array(IV_BYTES);
    root.crypto.getRandomValues(iv);
    return subtle()
      .encrypt({ name: 'AES-GCM', iv: iv }, key, encoder.encode(JSON.stringify(value)))
      .then(function (ciphertext) {
        var out = new Uint8Array(IV_BYTES + ciphertext.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ciphertext), IV_BYTES);
        return toBase64Url(out);
      });
  }

  /* Decrypt and parse; rejects if the frame was altered or sealed with another key. */
  function open(key, frame) {
    var bytes;
    try {
      bytes = fromBase64Url(frame);
    } catch (err) {
      return Promise.reject(err);
    }
    if (bytes.length < IV_BYTES + TAG_BYTES) return Promise.reject(new Error('Frame too short'));
    return subtle()
      .decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) }, key, bytes.subarray(IV_BYTES))
      .then(function (plaintext) {
        return JSON.parse(decoder.decode(plaintext));
      });
  }

  var api = {
    newSecret: newSecret,
    isSecret: isSecret,
    randomToken: randomToken,
    deriveRoom: deriveRoom,
    seal: seal,
    open: open,
    toBase64Url: toBase64Url,
    fromBase64Url: fromBase64Url
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.NetCrypto = api;
})(typeof window !== 'undefined' ? window : globalThis);
