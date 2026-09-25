/*
 * chess.js — a complete chess rules engine.
 *
 * Board representation is 0x88: a 128-entry array where a square is on the
 * board only if (sq & 0x88) === 0. Rank 0 is the 8th rank (top of the screen),
 * so a8 = 0 and h1 = 119. That makes off-board detection a single AND, which
 * keeps the sliding-piece loops short.
 *
 * Pieces are single characters: uppercase = white, lowercase = black.
 * PNBRQK / pnbrqk.
 *
 * Works as a plain browser script (window.ChessEngine) and as a CommonJS
 * module so the perft tests can run under node.
 */
(function (root) {
  'use strict';

  var WHITE = 'w';
  var BLACK = 'b';

  var EMPTY = null;

  var PAWN = 'p';
  var KNIGHT = 'n';
  var BISHOP = 'b';
  var ROOK = 'r';
  var QUEEN = 'q';
  var KING = 'k';

  var PIECE_VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

  var DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

  // Offsets. Rank 0 is at the top, so -16 moves "up" the board (toward rank 8).
  var KNIGHT_OFFSETS = [-33, -31, -18, -14, 14, 18, 31, 33];
  var BISHOP_OFFSETS = [-17, -15, 15, 17];
  var ROOK_OFFSETS = [-16, -1, 1, 16];
  var KING_OFFSETS = [-17, -16, -15, -1, 1, 15, 16, 17];

  var SLIDING_OFFSETS = {
    b: BISHOP_OFFSETS,
    r: ROOK_OFFSETS,
    q: BISHOP_OFFSETS.concat(ROOK_OFFSETS)
  };

  // Pawn capture directions, indexed by colour.
  var PAWN_CAPTURES = { w: [-17, -15], b: [15, 17] };
  var PAWN_PUSH = { w: -16, b: 16 };
  var SECOND_RANK = { w: 6, b: 1 }; // rank index of the pawns' starting row
  var PROMOTION_RANK = { w: 0, b: 7 };

  var FLAGS = {
    NORMAL: 'n',
    CAPTURE: 'c',
    BIG_PAWN: 'b', // two-square pawn advance
    EP_CAPTURE: 'e',
    PROMOTION: 'p',
    KSIDE_CASTLE: 'k',
    QSIDE_CASTLE: 'q'
  };

  var ROOK_HOME = {
    w: { k: 119, q: 112 }, // h1, a1
    b: { k: 7, q: 0 } //     h8, a8
  };

  var CASTLE_RIGHT_BIT = { wk: 1, wq: 2, bk: 4, bq: 8 };

  function rank(sq) {
    return sq >> 4;
  }

  function file(sq) {
    return sq & 15;
  }

  function isOnBoard(sq) {
    return (sq & 0x88) === 0;
  }

  function algebraic(sq) {
    return 'abcdefgh'[file(sq)] + (8 - rank(sq));
  }

  function fromAlgebraic(name) {
    if (typeof name !== 'string' || name.length !== 2) return -1;
    var f = 'abcdefgh'.indexOf(name[0]);
    var r = '12345678'.indexOf(name[1]);
    if (f === -1 || r === -1) return -1;
    return (7 - r) * 16 + f;
  }

  function colorOf(piece) {
    return piece === piece.toUpperCase() ? WHITE : BLACK;
  }

  function typeOf(piece) {
    return piece.toLowerCase();
  }

  function swapColor(color) {
    return color === WHITE ? BLACK : WHITE;
  }

  function pieceFor(type, color) {
    return color === WHITE ? type.toUpperCase() : type.toLowerCase();
  }

  function Chess(fen) {
    this.load(fen || DEFAULT_FEN);
  }

  Chess.prototype.reset = function () {
    this.load(DEFAULT_FEN);
  };

  Chess.prototype.load = function (fen) {
    var parts = String(fen).trim().split(/\s+/);
    if (parts.length < 4) throw new Error('Invalid FEN: ' + fen);

    var board = new Array(128).fill(EMPTY);
    var rows = parts[0].split('/');
    if (rows.length !== 8) throw new Error('Invalid FEN board: ' + parts[0]);

    for (var r = 0; r < 8; r++) {
      var f = 0;
      for (var i = 0; i < rows[r].length; i++) {
        var c = rows[r][i];
        if (/[1-8]/.test(c)) {
          f += parseInt(c, 10);
        } else if (/[pnbrqkPNBRQK]/.test(c)) {
          board[r * 16 + f] = c;
          f++;
        } else {
          throw new Error('Invalid FEN character: ' + c);
        }
      }
      if (f !== 8) throw new Error('Invalid FEN rank length: ' + rows[r]);
    }

    this._board = board;
    this._turn = parts[1] === BLACK ? BLACK : WHITE;

    this._castling = 0;
    if (parts[2].indexOf('K') !== -1) this._castling |= CASTLE_RIGHT_BIT.wk;
    if (parts[2].indexOf('Q') !== -1) this._castling |= CASTLE_RIGHT_BIT.wq;
    if (parts[2].indexOf('k') !== -1) this._castling |= CASTLE_RIGHT_BIT.bk;
    if (parts[2].indexOf('q') !== -1) this._castling |= CASTLE_RIGHT_BIT.bq;

    this._epSquare = parts[3] === '-' ? -1 : fromAlgebraic(parts[3]);
    this._halfMoves = parts.length > 4 ? parseInt(parts[4], 10) || 0 : 0;
    this._moveNumber = parts.length > 5 ? parseInt(parts[5], 10) || 1 : 1;

    this._history = [];
    this._positionCounts = {};
    this._countPosition();
  };

  Chess.prototype.fen = function () {
    var rows = [];
    for (var r = 0; r < 8; r++) {
      var row = '';
      var empty = 0;
      for (var f = 0; f < 8; f++) {
        var piece = this._board[r * 16 + f];
        if (piece === EMPTY) {
          empty++;
        } else {
          if (empty) row += empty;
          empty = 0;
          row += piece;
        }
      }
      if (empty) row += empty;
      rows.push(row);
    }

    var castling = '';
    if (this._castling & CASTLE_RIGHT_BIT.wk) castling += 'K';
    if (this._castling & CASTLE_RIGHT_BIT.wq) castling += 'Q';
    if (this._castling & CASTLE_RIGHT_BIT.bk) castling += 'k';
    if (this._castling & CASTLE_RIGHT_BIT.bq) castling += 'q';

    return [
      rows.join('/'),
      this._turn,
      castling || '-',
      this._epSquare === -1 ? '-' : algebraic(this._epSquare),
      this._halfMoves,
      this._moveNumber
    ].join(' ');
  };

  /*
   * Position key for repetition detection: FEN without the move counters.
   *
   * An en passant square only makes two positions different when the capture
   * is actually available. Recording it unconditionally would make the
   * position after 1.e4 look unlike the identical position reached again after
   * 1...Nf6 2.Nf3 Ng8 3.Ng1, and the threefold would never be spotted.
   */
  Chess.prototype._positionKey = function () {
    var fen = this.fen().split(' ');
    if (fen[3] !== '-' && !this._hasEnPassantCapture()) fen[3] = '-';
    return fen.slice(0, 4).join(' ');
  };

  Chess.prototype._hasEnPassantCapture = function () {
    if (this._epSquare === -1) return false;
    // Legal moves, not pseudo-legal: a pawn pinned against its king cannot
    // make the capture, so the right does not really exist.
    return this._generateMoves().some(function (move) {
      return move.flags.indexOf(FLAGS.EP_CAPTURE) !== -1;
    });
  };

  Chess.prototype._countPosition = function () {
    var key = this._positionKey();
    this._positionCounts[key] = (this._positionCounts[key] || 0) + 1;
  };

  Chess.prototype._uncountPosition = function () {
    var key = this._positionKey();
    if (this._positionCounts[key]) {
      this._positionCounts[key]--;
      if (!this._positionCounts[key]) delete this._positionCounts[key];
    }
  };

  Chess.prototype.turn = function () {
    return this._turn;
  };

  /* Returns 64 entries in display order (a8 first, h1 last). */
  Chess.prototype.board = function () {
    var out = [];
    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var sq = r * 16 + f;
        var piece = this._board[sq];
        out.push(
          piece === EMPTY
            ? null
            : { type: typeOf(piece), color: colorOf(piece), square: algebraic(sq) }
        );
      }
    }
    return out;
  };

  Chess.prototype.get = function (square) {
    var sq = fromAlgebraic(square);
    if (sq === -1 || !isOnBoard(sq)) return null;
    var piece = this._board[sq];
    return piece === EMPTY ? null : { type: typeOf(piece), color: colorOf(piece) };
  };

  Chess.prototype._kingSquare = function (color) {
    var king = pieceFor(KING, color);
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      if (this._board[sq] === king) return sq;
    }
    return -1;
  };

  /* Is `square` attacked by any piece of `color`? */
  Chess.prototype._isAttacked = function (square, color) {
    var board = this._board;
    var i, sq, offsets, offset;

    // Pawns. Walk backwards from the target along the attacker's capture rays.
    var pawnDirs = PAWN_CAPTURES[color];
    for (i = 0; i < pawnDirs.length; i++) {
      sq = square - pawnDirs[i];
      if (isOnBoard(sq) && board[sq] === pieceFor(PAWN, color)) return true;
    }

    // Knights.
    for (i = 0; i < KNIGHT_OFFSETS.length; i++) {
      sq = square + KNIGHT_OFFSETS[i];
      if (isOnBoard(sq) && board[sq] === pieceFor(KNIGHT, color)) return true;
    }

    // King.
    for (i = 0; i < KING_OFFSETS.length; i++) {
      sq = square + KING_OFFSETS[i];
      if (isOnBoard(sq) && board[sq] === pieceFor(KING, color)) return true;
    }

    // Sliding pieces: bishops/queens then rooks/queens.
    var rays = [
      { offsets: BISHOP_OFFSETS, pieces: [pieceFor(BISHOP, color), pieceFor(QUEEN, color)] },
      { offsets: ROOK_OFFSETS, pieces: [pieceFor(ROOK, color), pieceFor(QUEEN, color)] }
    ];
    for (var k = 0; k < rays.length; k++) {
      offsets = rays[k].offsets;
      for (i = 0; i < offsets.length; i++) {
        offset = offsets[i];
        sq = square + offset;
        while (isOnBoard(sq)) {
          var piece = board[sq];
          if (piece !== EMPTY) {
            if (piece === rays[k].pieces[0] || piece === rays[k].pieces[1]) return true;
            break;
          }
          sq += offset;
        }
      }
    }

    return false;
  };

  Chess.prototype.inCheck = function (color) {
    color = color || this._turn;
    var king = this._kingSquare(color);
    if (king === -1) return false;
    return this._isAttacked(king, swapColor(color));
  };

  function buildMove(board, from, to, flags, promotion) {
    var piece = board[from];
    var move = {
      from: from,
      to: to,
      color: colorOf(piece),
      piece: typeOf(piece),
      flags: flags
    };
    if (promotion) {
      move.flags += FLAGS.PROMOTION;
      move.promotion = promotion;
    }
    if (board[to] !== EMPTY) {
      move.captured = typeOf(board[to]);
    } else if (flags.indexOf(FLAGS.EP_CAPTURE) !== -1) {
      move.captured = PAWN;
    }
    return move;
  }

  Chess.prototype._generateMoves = function (options) {
    options = options || {};
    var board = this._board;
    var us = this._turn;
    var them = swapColor(us);
    var moves = [];
    var legalOnly = options.legal !== false;

    var firstSquare = 0;
    var lastSquare = 119;
    if (options.square) {
      var only = fromAlgebraic(options.square);
      if (only === -1 || !isOnBoard(only)) return [];
      firstSquare = lastSquare = only;
    }

    function addMove(from, to, flags) {
      var piece = board[from];
      if (typeOf(piece) === PAWN && rank(to) === PROMOTION_RANK[us]) {
        var promos = [QUEEN, ROOK, BISHOP, KNIGHT];
        for (var p = 0; p < promos.length; p++) {
          moves.push(buildMove(board, from, to, flags, promos[p]));
        }
      } else {
        moves.push(buildMove(board, from, to, flags));
      }
    }

    for (var from = firstSquare; from <= lastSquare; from++) {
      if (from & 0x88) {
        from += 7;
        continue;
      }

      var piece = board[from];
      if (piece === EMPTY || colorOf(piece) !== us) continue;

      var type = typeOf(piece);
      var i, offset, to;

      if (type === PAWN) {
        // Single push.
        var push = from + PAWN_PUSH[us];
        if (isOnBoard(push) && board[push] === EMPTY) {
          addMove(from, push, FLAGS.NORMAL);

          // Double push, only from the home rank and only if both are clear.
          var doublePush = from + 2 * PAWN_PUSH[us];
          if (rank(from) === SECOND_RANK[us] && board[doublePush] === EMPTY) {
            addMove(from, doublePush, FLAGS.BIG_PAWN);
          }
        }

        // Captures, including en passant.
        var caps = PAWN_CAPTURES[us];
        for (i = 0; i < caps.length; i++) {
          to = from + caps[i];
          if (!isOnBoard(to)) continue;
          if (board[to] !== EMPTY && colorOf(board[to]) === them) {
            addMove(from, to, FLAGS.CAPTURE);
          } else if (to === this._epSquare) {
            addMove(from, to, FLAGS.EP_CAPTURE);
          }
        }
      } else if (type === KNIGHT || type === KING) {
        var offsets = type === KNIGHT ? KNIGHT_OFFSETS : KING_OFFSETS;
        for (i = 0; i < offsets.length; i++) {
          to = from + offsets[i];
          if (!isOnBoard(to)) continue;
          if (board[to] === EMPTY) {
            addMove(from, to, FLAGS.NORMAL);
          } else if (colorOf(board[to]) === them) {
            addMove(from, to, FLAGS.CAPTURE);
          }
        }
      } else {
        var slides = SLIDING_OFFSETS[type];
        for (i = 0; i < slides.length; i++) {
          offset = slides[i];
          to = from + offset;
          while (isOnBoard(to)) {
            if (board[to] === EMPTY) {
              addMove(from, to, FLAGS.NORMAL);
            } else {
              if (colorOf(board[to]) === them) addMove(from, to, FLAGS.CAPTURE);
              break;
            }
            to += offset;
          }
        }
      }
    }

    // Castling. Generated from the king's square, so it is skipped when the
    // caller asked for a different single square.
    var kingSq = ROOK_HOME[us].k === 119 ? 116 : 4; // e1 / e8
    if (
      (!options.square || fromAlgebraic(options.square) === kingSq) &&
      board[kingSq] === pieceFor(KING, us)
    ) {
      if (this._castling & CASTLE_RIGHT_BIT[us + 'k']) {
        if (
          board[kingSq + 1] === EMPTY &&
          board[kingSq + 2] === EMPTY &&
          board[ROOK_HOME[us].k] === pieceFor(ROOK, us) &&
          !this._isAttacked(kingSq, them) &&
          !this._isAttacked(kingSq + 1, them) &&
          !this._isAttacked(kingSq + 2, them)
        ) {
          moves.push(buildMove(board, kingSq, kingSq + 2, FLAGS.KSIDE_CASTLE));
        }
      }
      if (this._castling & CASTLE_RIGHT_BIT[us + 'q']) {
        if (
          board[kingSq - 1] === EMPTY &&
          board[kingSq - 2] === EMPTY &&
          board[kingSq - 3] === EMPTY &&
          board[ROOK_HOME[us].q] === pieceFor(ROOK, us) &&
          !this._isAttacked(kingSq, them) &&
          !this._isAttacked(kingSq - 1, them) &&
          !this._isAttacked(kingSq - 2, them)
        ) {
          moves.push(buildMove(board, kingSq, kingSq - 2, FLAGS.QSIDE_CASTLE));
        }
      }
    }

    if (!legalOnly) return moves;

    var legal = [];
    for (var m = 0; m < moves.length; m++) {
      this._makeMove(moves[m]);
      if (!this._isAttacked(this._kingSquare(us), them)) legal.push(moves[m]);
      this._undoMove();
    }
    return legal;
  };

  /*
   * moves({ square, verbose })
   *   square:  restrict to moves starting from this square, e.g. 'e2'
   *   verbose: return move objects instead of SAN strings
   */
  Chess.prototype.moves = function (options) {
    options = options || {};
    var moves = this._generateMoves({ square: options.square });
    var self = this;
    if (!options.verbose) {
      return moves.map(function (m) {
        return self._toSan(m, moves);
      });
    }
    return moves.map(function (m) {
      return self._describe(m, moves);
    });
  };

  Chess.prototype._describe = function (move, siblings) {
    return {
      color: move.color,
      from: algebraic(move.from),
      to: algebraic(move.to),
      piece: move.piece,
      captured: move.captured,
      promotion: move.promotion,
      flags: move.flags,
      san: this._toSan(move, siblings)
    };
  };

  Chess.prototype._makeMove = function (move) {
    var board = this._board;
    var us = move.color;
    var them = swapColor(us);

    this._history.push({
      move: move,
      castling: this._castling,
      epSquare: this._epSquare,
      halfMoves: this._halfMoves,
      moveNumber: this._moveNumber,
      turn: this._turn
    });

    board[move.to] = board[move.from];
    board[move.from] = EMPTY;

    if (move.flags.indexOf(FLAGS.EP_CAPTURE) !== -1) {
      board[move.to + (us === WHITE ? 16 : -16)] = EMPTY;
    }

    if (move.promotion) {
      board[move.to] = pieceFor(move.promotion, us);
    }

    // Move the rook alongside a castling king.
    if (move.flags.indexOf(FLAGS.KSIDE_CASTLE) !== -1) {
      board[move.to - 1] = board[move.to + 1];
      board[move.to + 1] = EMPTY;
    } else if (move.flags.indexOf(FLAGS.QSIDE_CASTLE) !== -1) {
      board[move.to + 1] = board[move.to - 2];
      board[move.to - 2] = EMPTY;
    }

    // A king move of any kind forfeits both castling rights.
    if (move.piece === KING) {
      this._castling &= ~(CASTLE_RIGHT_BIT[us + 'k'] | CASTLE_RIGHT_BIT[us + 'q']);
    }
    // Moving a rook off its home square forfeits that side's right...
    if (move.from === ROOK_HOME[us].k) this._castling &= ~CASTLE_RIGHT_BIT[us + 'k'];
    if (move.from === ROOK_HOME[us].q) this._castling &= ~CASTLE_RIGHT_BIT[us + 'q'];
    // ...and so does capturing the opponent's rook on its home square.
    if (move.to === ROOK_HOME[them].k) this._castling &= ~CASTLE_RIGHT_BIT[them + 'k'];
    if (move.to === ROOK_HOME[them].q) this._castling &= ~CASTLE_RIGHT_BIT[them + 'q'];

    this._epSquare =
      move.flags.indexOf(FLAGS.BIG_PAWN) !== -1 ? move.from + PAWN_PUSH[us] : -1;

    if (move.piece === PAWN || move.captured) {
      this._halfMoves = 0;
    } else {
      this._halfMoves++;
    }

    if (us === BLACK) this._moveNumber++;
    this._turn = them;
  };

  Chess.prototype._undoMove = function () {
    var state = this._history.pop();
    if (!state) return null;

    var move = state.move;
    var board = this._board;
    var us = move.color;
    var them = swapColor(us);

    this._castling = state.castling;
    this._epSquare = state.epSquare;
    this._halfMoves = state.halfMoves;
    this._moveNumber = state.moveNumber;
    this._turn = state.turn;

    board[move.from] = move.promotion ? pieceFor(PAWN, us) : board[move.to];
    board[move.to] = EMPTY;

    if (move.flags.indexOf(FLAGS.EP_CAPTURE) !== -1) {
      board[move.to + (us === WHITE ? 16 : -16)] = pieceFor(PAWN, them);
    } else if (move.captured) {
      board[move.to] = pieceFor(move.captured, them);
    }

    if (move.flags.indexOf(FLAGS.KSIDE_CASTLE) !== -1) {
      board[move.to + 1] = board[move.to - 1];
      board[move.to - 1] = EMPTY;
    } else if (move.flags.indexOf(FLAGS.QSIDE_CASTLE) !== -1) {
      board[move.to - 2] = board[move.to + 1];
      board[move.to + 1] = EMPTY;
    }

    return move;
  };

  /*
   * Standard Algebraic Notation, with just enough disambiguation to be
   * unambiguous (file, then rank, then both).
   */
  Chess.prototype._toSan = function (move, siblings) {
    if (move.flags.indexOf(FLAGS.KSIDE_CASTLE) !== -1) {
      return this._withCheckSuffix(move, 'O-O');
    }
    if (move.flags.indexOf(FLAGS.QSIDE_CASTLE) !== -1) {
      return this._withCheckSuffix(move, 'O-O-O');
    }

    var san = '';
    if (move.piece === PAWN) {
      if (move.captured) san += 'abcdefgh'[file(move.from)] + 'x';
      san += algebraic(move.to);
      if (move.promotion) san += '=' + move.promotion.toUpperCase();
    } else {
      san += move.piece.toUpperCase();
      san += this._disambiguate(move, siblings || this._generateMoves());
      if (move.captured) san += 'x';
      san += algebraic(move.to);
    }

    return this._withCheckSuffix(move, san);
  };

  Chess.prototype._disambiguate = function (move, moves) {
    var sameFile = 0;
    var sameRank = 0;
    var ambiguous = 0;

    for (var i = 0; i < moves.length; i++) {
      var other = moves[i];
      if (
        other.piece !== move.piece ||
        other.to !== move.to ||
        other.from === move.from ||
        other.color !== move.color
      ) {
        continue;
      }
      ambiguous++;
      if (file(other.from) === file(move.from)) sameFile++;
      if (rank(other.from) === rank(move.from)) sameRank++;
    }

    if (!ambiguous) return '';
    if (!sameFile) return 'abcdefgh'[file(move.from)];
    if (!sameRank) return String(8 - rank(move.from));
    return algebraic(move.from);
  };

  Chess.prototype._withCheckSuffix = function (move, san) {
    this._makeMove(move);
    var suffix = '';
    if (this.inCheck()) {
      suffix = this._generateMoves().length === 0 ? '#' : '+';
    }
    this._undoMove();
    return san + suffix;
  };

  /*
   * move({ from: 'e2', to: 'e4', promotion: 'q' }) or move('e4') / move('Nf3')
   * Returns a plain description of the move, or null if it was illegal.
   */
  Chess.prototype.move = function (input) {
    var moves = this._generateMoves();
    var chosen = null;
    var i;

    if (typeof input === 'string') {
      for (i = 0; i < moves.length; i++) {
        if (this._toSan(moves[i], moves).replace(/[+#]/g, '') === input.replace(/[+#]/g, '')) {
          chosen = moves[i];
          break;
        }
      }
    } else if (input && typeof input === 'object') {
      var from = fromAlgebraic(input.from);
      var to = fromAlgebraic(input.to);
      for (i = 0; i < moves.length; i++) {
        if (moves[i].from !== from || moves[i].to !== to) continue;
        if (moves[i].promotion && moves[i].promotion !== (input.promotion || QUEEN)) continue;
        chosen = moves[i];
        break;
      }
    }

    if (!chosen) return null;

    var described = this._describe(chosen, moves);
    described.before = this.fen();
    this._makeMove(chosen);
    described.after = this.fen();
    this._countPosition();
    return described;
  };

  Chess.prototype.undo = function () {
    if (!this._history.length) return null;
    this._uncountPosition();
    var move = this._undoMove();
    return move ? this._describe(move, [move]) : null;
  };

  /*
   * The moves played so far. SAN is re-derived by replaying the game from its
   * starting position, since notation depends on the position a move was made
   * in and cheap storage of it would go stale after an undo.
   */
  Chess.prototype.history = function (options) {
    options = options || {};
    var moves = this._history.map(function (state) {
      return state.move;
    });
    var game = new Chess(this._startFen());
    var out = [];

    for (var i = 0; i < moves.length; i++) {
      var legal = game._generateMoves();
      var described = null;
      for (var j = 0; j < legal.length; j++) {
        if (
          legal[j].from === moves[i].from &&
          legal[j].to === moves[i].to &&
          legal[j].promotion === moves[i].promotion
        ) {
          described = game._describe(legal[j], legal);
          game._makeMove(legal[j]);
          break;
        }
      }
      if (!described) break;
      out.push(options.verbose ? described : described.san);
    }
    return out;
  };

  /* FEN of the position before any move in the current history was played. */
  Chess.prototype._startFen = function () {
    var undone = [];
    while (this._history.length) undone.push(this._undoMove());
    var fen = this.fen();
    for (var i = undone.length - 1; i >= 0; i--) this._makeMove(undone[i]);
    return fen;
  };

  Chess.prototype.moveCount = function () {
    return this._history.length;
  };

  Chess.prototype.isCheckmate = function () {
    return this.inCheck() && this._generateMoves().length === 0;
  };

  Chess.prototype.isStalemate = function () {
    return !this.inCheck() && this._generateMoves().length === 0;
  };

  Chess.prototype.isInsufficientMaterial = function () {
    var pieces = { w: [], b: [] };
    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      var piece = this._board[sq];
      if (piece === EMPTY) continue;
      var type = typeOf(piece);
      if (type === KING) continue;
      pieces[colorOf(piece)].push({ type: type, square: sq });
    }

    var all = pieces.w.concat(pieces.b);
    if (all.length === 0) return true; // K vs K
    if (all.length === 1 && (all[0].type === BISHOP || all[0].type === KNIGHT)) return true;

    // King and bishop(s) vs king and bishop(s), all on one colour complex.
    if (
      all.length === all.filter(function (p) {
        return p.type === BISHOP;
      }).length
    ) {
      var colors = all.map(function (p) {
        return (rank(p.square) + file(p.square)) % 2;
      });
      if (
        colors.every(function (c) {
          return c === colors[0];
        })
      ) {
        return true;
      }
    }

    return false;
  };

  Chess.prototype.isThreefoldRepetition = function () {
    var counts = this._positionCounts;
    for (var key in counts) {
      if (counts[key] >= 3) return true;
    }
    return false;
  };

  Chess.prototype.isFiftyMoveRule = function () {
    return this._halfMoves >= 100;
  };

  Chess.prototype.isDraw = function () {
    return (
      this.isStalemate() ||
      this.isInsufficientMaterial() ||
      this.isThreefoldRepetition() ||
      this.isFiftyMoveRule()
    );
  };

  Chess.prototype.isGameOver = function () {
    return this.isCheckmate() || this.isDraw();
  };

  /* A short human-readable status, e.g. "Checkmate — White wins". */
  Chess.prototype.status = function () {
    var mover = this._turn === WHITE ? 'White' : 'Black';
    if (this.isCheckmate()) {
      return {
        over: true,
        result: this._turn === WHITE ? '0-1' : '1-0',
        text: 'Checkmate — ' + (this._turn === WHITE ? 'Black' : 'White') + ' wins'
      };
    }
    if (this.isStalemate()) return { over: true, result: '1/2-1/2', text: 'Stalemate — draw' };
    if (this.isInsufficientMaterial()) {
      return { over: true, result: '1/2-1/2', text: 'Draw — insufficient material' };
    }
    if (this.isThreefoldRepetition()) {
      return { over: true, result: '1/2-1/2', text: 'Draw — threefold repetition' };
    }
    if (this.isFiftyMoveRule()) {
      return { over: true, result: '1/2-1/2', text: 'Draw — fifty-move rule' };
    }
    if (this.inCheck()) return { over: false, check: true, text: mover + ' is in check' };
    return { over: false, check: false, text: mover + ' to move' };
  };

  /*
   * What each side has captured, and who is ahead.
   *
   *   lost[c]    pieces of colour c that have been captured, taken from the
   *              moves actually played — comparing piece counts against the
   *              starting position instead would read a promoted pawn as a
   *              captured one.
   *   points[c]  what colour c has captured, in the usual piece values.
   *   balance    material on the board from White's point of view, so a
   *              promotion shows up as the advantage it is.
   *
   * Everything reflects the position currently loaded, so stepping back
   * through the game reports the material at that point.
   */
  Chess.prototype.material = function () {
    var result = {
      lost: { w: [], b: [] },
      points: { w: 0, b: 0 },
      balance: 0
    };

    this._history.forEach(function (state) {
      var move = state.move;
      if (!move.captured) return;
      var victim = swapColor(move.color);
      result.lost[victim].push(move.captured);
      result.points[move.color] += PIECE_VALUES[move.captured];
    });

    [WHITE, BLACK].forEach(function (color) {
      result.lost[color].sort(function (a, b) {
        return PIECE_VALUES[b] - PIECE_VALUES[a];
      });
    });

    for (var sq = 0; sq < 128; sq++) {
      if (sq & 0x88) {
        sq += 7;
        continue;
      }
      var piece = this._board[sq];
      if (piece === EMPTY) continue;
      var value = PIECE_VALUES[typeOf(piece)];
      result.balance += colorOf(piece) === WHITE ? value : -value;
    }

    return result;
  };

  Chess.prototype.pgn = function (headers) {
    var lines = [];
    headers = headers || {};
    Object.keys(headers).forEach(function (key) {
      lines.push('[' + key + ' "' + String(headers[key]).replace(/"/g, "'") + '"]');
    });
    if (lines.length) lines.push('');

    var sans = this.history();
    var body = [];
    for (var i = 0; i < sans.length; i += 2) {
      var number = i / 2 + 1;
      body.push(number + '. ' + sans[i] + (sans[i + 1] ? ' ' + sans[i + 1] : ''));
    }

    var status = this.status();
    if (status.over) body.push(status.result);

    // Wrap the movetext at a sensible width, the way PGN readers expect.
    var line = '';
    body.forEach(function (chunk) {
      if ((line + ' ' + chunk).trim().length > 78) {
        lines.push(line.trim());
        line = '';
      }
      line += (line ? ' ' : '') + chunk;
    });
    if (line) lines.push(line.trim());

    return lines.join('\n');
  };

  Chess.PIECE_VALUES = PIECE_VALUES;
  Chess.DEFAULT_FEN = DEFAULT_FEN;
  Chess.WHITE = WHITE;
  Chess.BLACK = BLACK;

  var api = { Chess: Chess, PIECE_VALUES: PIECE_VALUES, DEFAULT_FEN: DEFAULT_FEN };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  root.ChessEngine = api;
})(typeof window !== 'undefined' ? window : globalThis);
