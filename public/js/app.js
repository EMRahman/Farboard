/*
 * app.js — the board UI.
 *
 * The board shows the online game that online.js drives through
 * window.Farboard. With no game in progress it sits idle at the starting
 * position while the side panel offers to host or join one.
 *
 * The engine in chess.js holds the position for whatever ply is currently on
 * screen. Moves that have been stepped back over live on a `future` stack, so
 * navigating the game is just a series of undo/redo operations rather than a
 * replay from the start.
 */
(function () {
  'use strict';

  var Chess = window.ChessEngine.Chess;
  var PIECE_VALUES = window.ChessEngine.PIECE_VALUES;

  // Display preferences only. (ChessTracker, the one-device board Farboard grew
  // out of, may share this origin; its 'chesstracker:v1' game is not ours to touch.)
  var STORAGE_KEY = 'farboard:v1';
  var FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  var RANKS = ['8', '7', '6', '5', '4', '3', '2', '1'];

  // Solid glyphs for both colours; white pieces are filled light and outlined
  // in CSS. Using one glyph set keeps the shapes identical between sides,
  // which is what makes a piece readable at a glance.
  // U+FE0E forces text presentation: without it, iOS renders the pawn glyph
  // as a fixed-colour emoji image (ignoring the CSS below) while the other
  // five pieces render as styleable text, so pawns looked off-style and
  // white pawns looked black.
  var GLYPHS = {
    k: '♚︎',
    q: '♛︎',
    r: '♜︎',
    b: '♝︎',
    n: '♞︎',
    p: '♟︎'
  };
  var PIECE_NAMES = {
    k: 'king',
    q: 'queen',
    r: 'rook',
    b: 'bishop',
    n: 'knight',
    p: 'pawn'
  };

  var state = {
    game: new Chess(),
    future: [], // moves stepped back over, most recent last
    selected: null, // square name, e.g. 'e2'
    selectionMoves: [], // legal moves from the selected square
    preview: false, // true when showing moves for the side NOT to move
    orientation: 'w',
    showCoords: true,
    pendingPromotion: null
  };

  var el = {};
  var squares = {}; // square name -> element

  /*
   * The game online.js has put on the board, or null when there is none and
   * the board is idle:
   * { color: 'w' | 'b' | null, outcome: text | null, peerLeft, canTakeBack }
   */
  var online = null;
  var hooks = { move: null, action: null };

  /* Whether this device may play `color` right now. */
  function mayMove(color) {
    return !!online && online.color === color && !online.outcome;
  }

  function $(id) {
    return document.getElementById(id);
  }

  function cacheElements() {
    el.board = $('board');
    el.status = $('status');
    el.hint = $('hint');
    el.moveList = $('moveList');
    el.moveCount = $('moveCount');
    el.emptyMoves = $('emptyMoves');
    el.boardPanel = $('boardPanel');
    el.stripTop = $('strip-top');
    el.stripBottom = $('strip-bottom');
    el.overlay = $('boardOverlay');
    el.overlayText = $('overlayText');
    el.overlayNewGame = $('overlayNewGame');
    el.toast = $('boardToast');
    el.promotionBackdrop = $('promotionBackdrop');
    el.promotionChoices = $('promotionChoices');
    el.toolFeedback = $('toolFeedback');
    el.firstBtn = $('firstBtn');
    el.backBtn = $('backBtn');
    el.forwardBtn = $('forwardBtn');
    el.lastBtn = $('lastBtn');
    el.undoBtn = $('undoBtn');
    el.showCoords = $('showCoords');
  }

  /* ---------------------------------------------------------------- board */

  function buildBoard() {
    el.board.innerHTML = '';
    squares = {};

    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var name = FILES[f] + RANKS[r];
        var square = document.createElement('div');
        square.className = 'sq ' + ((r + f) % 2 === 0 ? 'light' : 'dark');
        square.dataset.square = name;
        square.setAttribute('role', 'gridcell');
        square.setAttribute('tabindex', '-1');

        var piece = document.createElement('span');
        piece.className = 'piece';
        square.appendChild(piece);

        var rankLabel = document.createElement('span');
        rankLabel.className = 'coord coord-rank';
        square.appendChild(rankLabel);

        var fileLabel = document.createElement('span');
        fileLabel.className = 'coord coord-file';
        square.appendChild(fileLabel);

        squares[name] = square;
      }
    }

    orderBoard();
  }

  /* Re-append the squares in the order the current orientation needs. */
  function orderBoard() {
    var files = state.orientation === 'w' ? FILES : FILES.slice().reverse();
    var ranks = state.orientation === 'w' ? RANKS : RANKS.slice().reverse();
    var fragment = document.createDocumentFragment();

    for (var r = 0; r < 8; r++) {
      for (var f = 0; f < 8; f++) {
        var name = files[f] + ranks[r];
        var square = squares[name];
        // Coordinates sit on the outer edges only, like a printed board:
        // ranks down the left-hand side, files along the bottom.
        square.querySelector('.coord-rank').textContent = f === 0 ? ranks[r] : '';
        square.querySelector('.coord-file').textContent = r === 7 ? files[f] : '';
        fragment.appendChild(square);
      }
    }

    el.board.appendChild(fragment);
  }

  function renderBoard() {
    var position = state.game.board();
    var lastMove = lastPlayedMove();
    var checkSquare = null;

    if (state.game.inCheck()) {
      checkSquare = findKing(position, state.game.turn());
    }

    var targets = {};
    state.selectionMoves.forEach(function (move) {
      targets[move.to] = move;
    });

    for (var i = 0; i < 64; i++) {
      var name = FILES[i % 8] + RANKS[Math.floor(i / 8)];
      var square = squares[name];
      var piece = position[i];
      var glyph = square.querySelector('.piece');

      if (piece) {
        glyph.textContent = GLYPHS[piece.type];
        glyph.className =
          'piece piece-' + piece.type + ' ' + (piece.color === 'w' ? 'white' : 'black');
        square.setAttribute(
          'aria-label',
          name + ', ' + (piece.color === 'w' ? 'white ' : 'black ') + PIECE_NAMES[piece.type]
        );
      } else {
        glyph.textContent = '';
        glyph.className = 'piece';
        square.setAttribute('aria-label', name + ', empty');
      }

      var target = targets[name];
      square.classList.toggle('selected', state.selected === name);
      square.classList.toggle('target', !!target && !target.captured);
      square.classList.toggle('target-capture', !!target && !!target.captured);
      square.classList.toggle('preview', !!target && state.preview);
      square.classList.toggle('last-from', !!lastMove && lastMove.from === name);
      square.classList.toggle('last-to', !!lastMove && lastMove.to === name);
      square.classList.toggle('in-check', checkSquare === name);
      square.setAttribute('tabindex', piece || target ? '0' : '-1');
    }
  }

  function findKing(position, color) {
    for (var i = 0; i < 64; i++) {
      var piece = position[i];
      if (piece && piece.type === 'k' && piece.color === color) {
        return FILES[i % 8] + RANKS[Math.floor(i / 8)];
      }
    }
    return null;
  }

  function lastPlayedMove() {
    var history = state.game.history({ verbose: true });
    return history.length ? history[history.length - 1] : null;
  }

  /* ------------------------------------------------------------ selection */

  function selectSquare(name) {
    var piece = state.game.get(name);
    if (!piece) return clearSelection();

    // In an online game the side to move may be the opponent's; their moves
    // are shown as a preview, just like tapping the waiting side's pieces.
    var isMover = piece.color === state.game.turn();
    state.selected = name;
    state.preview = !(isMover && mayMove(piece.color));
    state.selectionMoves = isMover ? state.game.moves({ square: name, verbose: true }) : previewMoves(name);

    renderBoard();
    renderHint(piece, name);
  }

  /*
   * Moves for a piece belonging to the side that is NOT to move. Useful when
   * you are sizing up the opponent's threats before touching your own pieces.
   * The position is reloaded with the turn flipped so the engine's normal
   * legality filtering applies to that colour's king.
   */
  function previewMoves(name) {
    var parts = state.game.fen().split(' ');
    parts[1] = parts[1] === 'w' ? 'b' : 'w';
    parts[3] = '-'; // an en passant square only belongs to the real mover
    try {
      return new Chess(parts.join(' ')).moves({ square: name, verbose: true });
    } catch (err) {
      return [];
    }
  }

  function clearSelection() {
    state.selected = null;
    state.selectionMoves = [];
    state.preview = false;
    renderBoard();
    renderHint(null);
  }

  function renderHint(piece, name) {
    if (!piece) {
      el.hint.textContent = viewingHistory()
        ? 'You are looking at an earlier position. Jump to the latest move to keep playing.'
        : idleHint();
      el.hint.classList.remove('preview');
      return;
    }

    var count = state.selectionMoves.length;
    var who = piece.color === 'w' ? 'White' : 'Black';
    var label = who + ' ' + PIECE_NAMES[piece.type] + ' on ' + name;

    if (count === 0) {
      el.hint.textContent = label + ' has no legal moves.';
    } else if (state.preview) {
      el.hint.textContent =
        label +
        ' — ' +
        count +
        (count === 1 ? ' move' : ' moves') +
        ' (not yours to play).';
    } else {
      el.hint.textContent = label + ' — ' + count + (count === 1 ? ' legal move.' : ' legal moves.');
    }
    el.hint.classList.toggle('preview', state.preview);
  }

  function idleHint() {
    if (!online) return '';
    if (!online.color) return 'Waiting to hear from the other player…';
    if (online.peerLeft) return 'Your opponent left. Start a new invite to play again.';
    if (online.outcome || state.game.isGameOver()) return 'The game is over. Ask for a rematch to play again.';
    if (state.game.turn() !== online.color) {
      return 'Your opponent is thinking — tap their pieces to see what they can do.';
    }
    return 'Your move. Tap a piece to see where it can go.';
  }

  /* ----------------------------------------------------------- move entry */

  function handleSquareClick(name) {
    if (!online || state.pendingPromotion) return;

    if (viewingHistory()) {
      // Playing from a reviewed position would silently discard the rest of
      // the game, so require an explicit jump back to the live position.
      var move = state.selectionMoves.find(function (m) {
        return m.to === name;
      });
      if (!move) return selectSquare(name);
      flash('Jump to the latest move before entering a new one.');
      return;
    }

    if (state.selected && !state.preview && mayMove(state.game.turn())) {
      var chosen = state.selectionMoves.filter(function (m) {
        return m.to === name;
      });
      if (chosen.length) {
        if (chosen[0].promotion) {
          askPromotion(state.selected, name, chosen[0].color);
        } else {
          playMove({ from: state.selected, to: name });
        }
        return;
      }
    }

    if (state.selected === name) return clearSelection();
    if (state.game.get(name)) return selectSquare(name);
    clearSelection();
  }

  function playMove(request) {
    var move = state.game.move(request);
    if (!move) return;

    clearSelection();
    render();
    if (hooks.move) hooks.move(move);
  }

  function askPromotion(from, to, color) {
    state.pendingPromotion = { from: from, to: to };
    el.promotionChoices.innerHTML = '';

    ['q', 'r', 'b', 'n'].forEach(function (type) {
      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'promotion-choice';
      button.dataset.promotion = type;
      button.setAttribute('aria-label', 'Promote to ' + PIECE_NAMES[type]);
      button.innerHTML =
        '<span class="piece ' + (color === 'w' ? 'white' : 'black') + '">' + GLYPHS[type] + '</span>';
      el.promotionChoices.appendChild(button);
    });

    el.promotionBackdrop.hidden = false;
    var first = el.promotionChoices.querySelector('button');
    if (first) first.focus();
  }

  function closePromotion() {
    state.pendingPromotion = null;
    el.promotionBackdrop.hidden = true;
  }

  /* ---------------------------------------------------------- navigation */

  function viewingHistory() {
    return state.future.length > 0;
  }

  function stepBack() {
    var history = state.game.history({ verbose: true });
    if (!history.length) return false;
    var move = history[history.length - 1];
    state.game.undo();
    state.future.push(move);
    return true;
  }

  function stepForward() {
    if (!state.future.length) return false;
    var move = state.future.pop();
    state.game.move({ from: move.from, to: move.to, promotion: move.promotion });
    return true;
  }

  function goToPly(ply) {
    while (state.game.moveCount() > ply && stepBack()) {
      /* rewind */
    }
    while (state.game.moveCount() < ply && stepForward()) {
      /* fast forward */
    }
    afterNavigation();
  }

  function afterNavigation() {
    clearSelection();
    render();
  }

  /* Your opponent has to agree to a take-back; online.js asks them. */
  function takeBack() {
    if (online && online.canTakeBack && hooks.action) hooks.action('takeback');
  }

  function totalPlies() {
    return state.game.moveCount() + state.future.length;
  }

  /* --------------------------------------------------------------- panels */

  function renderStatus() {
    var status = state.game.status();
    var text = status.text;
    var over = !!status.over;
    // A resignation, an agreed draw or a departure is not visible on the board itself.
    if (online && online.outcome) {
      text = online.outcome;
      over = true;
    }
    el.status.textContent = text;
    el.status.classList.toggle('check', !!status.check && !over);
    el.status.classList.toggle('over', over);

    var showOverlay = !!online && !!online.color && over && !viewingHistory();
    el.overlay.hidden = !showOverlay;
    if (showOverlay) {
      el.overlayText.textContent = text;
      el.overlayNewGame.textContent = online.peerLeft ? 'New invite' : 'Rematch (swap colours)';
    }
  }

  function renderStrips() {
    var material = state.game.material();
    var topColor = state.orientation === 'w' ? 'b' : 'w';

    fillStrip(el.stripTop, topColor, material);
    fillStrip(el.stripBottom, topColor === 'w' ? 'b' : 'w', material);
  }

  function fillStrip(strip, color, material) {
    var name = color === 'w' ? 'White' : 'Black';
    var live = !!online && !online.outcome && !state.game.isGameOver();
    strip.classList.toggle('to-move', live && state.game.turn() === color);
    var who = online && online.color ? (online.color === color ? 'You · ' : 'Opponent · ') : '';
    strip.querySelector('.player-name').textContent = who + name;
    strip.querySelector('.dot').className = 'dot ' + (color === 'w' ? 'white' : 'black');

    // The pieces this player has captured are the ones the opponent has lost.
    var taken = material.lost[color === 'w' ? 'b' : 'w'];
    var captured = strip.querySelector('.captured');
    captured.innerHTML = '';

    var order = ['q', 'r', 'b', 'n', 'p'];
    order.forEach(function (type) {
      var count = taken.filter(function (t) {
        return t === type;
      }).length;
      for (var i = 0; i < count; i++) {
        var glyph = document.createElement('span');
        glyph.className = 'taken piece-' + type + ' ' + (color === 'w' ? 'black' : 'white');
        glyph.textContent = GLYPHS[type];
        glyph.title = PIECE_NAMES[type] + ' (' + PIECE_VALUES[type] + ')';
        captured.appendChild(glyph);
      }
    });

    // The lead comes from the material actually on the board, so promoting a
    // pawn shows as the gain it is rather than tracking captures alone.
    var lead = color === 'w' ? material.balance : -material.balance;
    var leadEl = strip.querySelector('.lead');
    leadEl.textContent = lead > 0 ? '+' + lead : '';
    leadEl.title = lead > 0 ? name + ' is ahead by ' + lead + ' points of material' : '';
  }

  function renderMoves() {
    var played = state.game.history({ verbose: true });
    var upcoming = state.future.slice().reverse(); // future is stored newest-last
    var all = played.concat(upcoming);

    el.moveList.innerHTML = '';
    el.moveCount.textContent = all.length;
    el.emptyMoves.hidden = all.length > 0;

    for (var i = 0; i < all.length; i += 2) {
      var row = document.createElement('li');
      row.className = 'move-row';

      var number = document.createElement('span');
      number.className = 'move-number';
      number.textContent = i / 2 + 1 + '.';
      row.appendChild(number);

      row.appendChild(moveButton(all[i], i + 1, played.length));
      if (all[i + 1]) row.appendChild(moveButton(all[i + 1], i + 2, played.length));

      el.moveList.appendChild(row);
    }

    var current = el.moveList.querySelector('.move.current');
    if (current) scrollListTo(current);
  }

  /*
   * Bring a move into view by scrolling the move list only. scrollIntoView
   * would also scroll the page, which on a phone yanks the board off screen
   * after every move.
   */
  function scrollListTo(item) {
    var list = el.moveList.getBoundingClientRect();
    var box = item.getBoundingClientRect();
    if (box.top < list.top) el.moveList.scrollTop -= list.top - box.top;
    else if (box.bottom > list.bottom) el.moveList.scrollTop += box.bottom - list.bottom;
  }

  function moveButton(move, ply, playedCount) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'move';
    button.dataset.ply = ply;
    button.textContent = move.san;
    if (ply === playedCount) button.classList.add('current');
    if (ply > playedCount) button.classList.add('future');
    button.setAttribute(
      'aria-label',
      (move.color === 'w' ? 'White' : 'Black') + ' played ' + move.san + ', move ' + Math.ceil(ply / 2)
    );
    return button;
  }

  function renderControls() {
    var atStart = state.game.moveCount() === 0;
    var atEnd = state.future.length === 0;
    el.firstBtn.disabled = atStart;
    el.backBtn.disabled = atStart;
    el.forwardBtn.disabled = atEnd;
    el.lastBtn.disabled = atEnd;
    el.undoBtn.disabled = !online || !online.canTakeBack;
  }

  function render() {
    document.body.classList.toggle('hide-coords', !state.showCoords);
    document.body.classList.toggle('in-game', !!online);
    el.boardPanel.classList.toggle('idle', !online);
    orderBoard();
    renderBoard();
    renderStatus();
    renderStrips();
    renderMoves();
    renderControls();
    renderHint(state.selected ? state.game.get(state.selected) : null, state.selected);
  }

  /* ------------------------------------------------------------ feedback */

  /* Game events, shown over the foot of the board where the player is looking. */
  var flashTimer = null;
  function flash(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    el.toast.classList.remove('fading');
    clearTimeout(flashTimer);
    flashTimer = setTimeout(function () {
      el.toast.classList.add('fading');
      flashTimer = setTimeout(function () {
        el.toast.hidden = true;
      }, 300);
    }, 2600);
  }

  /* Confirmations for the copy buttons, next to them. */
  var noteTimer = null;
  function note(message) {
    el.toolFeedback.textContent = message;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(function () {
      el.toolFeedback.textContent = '';
    }, 2600);
  }

  /* report: where to confirm it; the copy buttons by the board use note(). */
  function copyText(text, label, report) {
    var done = report || flash;
    function fallback() {
      var area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      try {
        document.execCommand('copy');
        done(label + ' copied.');
      } catch (err) {
        done('Could not copy — ' + label + ': ' + text);
      }
      document.body.removeChild(area);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () {
          done(label + ' copied.');
        },
        fallback
      );
    } else {
      fallback();
    }
  }

  /* ----------------------------------------------------------- persistence */

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ showCoords: state.showCoords }));
    } catch (err) {
      /* private browsing, quota, etc. — only the preference is lost */
    }
  }

  function restore() {
    try {
      var saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (saved) state.showCoords = saved.showCoords !== false;
    } catch (err) {
      /* keep the defaults */
    }
  }

  function newGame() {
    if (hooks.action) hooks.action('newgame');
  }

  /* --------------------------------------------------------------- online */

  /*
   * Put a game on the board (opts) or leave it idle at the starting position
   * (null). Calling it again during a game updates colour, result and what
   * may be asked for; the board is redrawn but the selection is kept.
   */
  function setOnline(opts) {
    if (opts) {
      var colorChanged = !online || online.color !== (opts.color || null);
      var outcomeChanged = !online || online.outcome !== (opts.outcome || null);
      online = {
        color: opts.color || null,
        outcome: opts.outcome || null,
        peerLeft: !!opts.peerLeft,
        canTakeBack: !!opts.canTakeBack
      };
      if (colorChanged) state.orientation = online.color || 'w';
      if (colorChanged || outcomeChanged) {
        closePromotion();
        clearSelection();
      }
    } else {
      online = null;
      state.game = new Chess();
      state.future = [];
      state.orientation = 'w';
      closePromotion();
      clearSelection();
    }
    render();
  }

  /* Replace the game on the board with these moves, viewed at the latest one. */
  function loadGame(moves) {
    var game = new Chess();
    for (var i = 0; i < moves.length; i++) {
      if (!game.move(moves[i])) break;
    }
    state.game = game;
    state.future = [];
    closePromotion();
    clearSelection();
    render();
  }

  /*
   * Play the opponent's move at the end of the game. If you are looking back
   * through earlier moves you stay where you are; the new move joins the
   * list ahead of you. Returns the move, or null if it was not legal.
   */
  function applyRemoteMove(request) {
    var viewPly = viewingHistory() ? state.game.moveCount() : -1;
    while (stepForward()) {
      /* to the latest position */
    }
    var move = state.game.move(request);
    while (viewPly !== -1 && state.game.moveCount() > viewPly && stepBack()) {
      /* back to where you were looking */
    }
    clearSelection();
    render();
    return move;
  }

  window.Farboard = {
    setOnline: setOnline,
    loadGame: loadGame,
    applyRemoteMove: applyRemoteMove,
    onLocalMove: function (fn) {
      hooks.move = fn;
    },
    onAction: function (fn) {
      hooks.action = fn;
    },
    flash: flash,
    copyText: copyText
  };

  /* -------------------------------------------------------------- events */

  function bindEvents() {
    el.board.addEventListener('click', function (event) {
      var square = event.target.closest('.sq');
      if (square) handleSquareClick(square.dataset.square);
    });

    el.board.addEventListener('keydown', function (event) {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      var square = event.target.closest('.sq');
      if (!square) return;
      event.preventDefault();
      handleSquareClick(square.dataset.square);
    });

    el.moveList.addEventListener('click', function (event) {
      var button = event.target.closest('.move');
      if (button) goToPly(parseInt(button.dataset.ply, 10));
    });

    el.firstBtn.addEventListener('click', function () {
      goToPly(0);
    });
    el.backBtn.addEventListener('click', function () {
      goToPly(state.game.moveCount() - 1);
    });
    el.forwardBtn.addEventListener('click', function () {
      goToPly(state.game.moveCount() + 1);
    });
    el.lastBtn.addEventListener('click', function () {
      goToPly(totalPlies());
    });
    el.undoBtn.addEventListener('click', takeBack);

    $('flipBtn').addEventListener('click', flip);
    el.overlayNewGame.addEventListener('click', newGame);

    el.showCoords.addEventListener('change', function () {
      state.showCoords = el.showCoords.checked;
      render();
      save();
    });

    $('copyPgnBtn').addEventListener('click', function () {
      var complete = new Chess();
      var moves = state.game.history({ verbose: true }).concat(state.future.slice().reverse());
      moves.forEach(function (move) {
        complete.move({ from: move.from, to: move.to, promotion: move.promotion });
      });
      var mine = online && online.color;
      copyText(
        complete.pgn({
          Event: 'Online game',
          Site: 'Farboard',
          Date: new Date().toISOString().slice(0, 10).replace(/-/g, '.'),
          White: mine ? (mine === 'w' ? 'You' : 'Opponent') : 'White',
          Black: mine ? (mine === 'b' ? 'You' : 'Opponent') : 'Black'
        }),
        'PGN',
        note
      );
    });

    $('copyFenBtn').addEventListener('click', function () {
      copyText(state.game.fen(), 'FEN', note);
    });

    el.promotionChoices.addEventListener('click', function (event) {
      var button = event.target.closest('[data-promotion]');
      if (!button || !state.pendingPromotion) return;
      var request = {
        from: state.pendingPromotion.from,
        to: state.pendingPromotion.to,
        promotion: button.dataset.promotion
      };
      closePromotion();
      playMove(request);
    });

    $('promotionCancel').addEventListener('click', closePromotion);
    el.promotionBackdrop.addEventListener('click', function (event) {
      if (event.target === el.promotionBackdrop) closePromotion();
    });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Escape') {
        if (state.pendingPromotion) return closePromotion();
        return clearSelection();
      }
      if (state.pendingPromotion) return;

      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName);
      if (typing) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        return takeBack();
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          goToPly(state.game.moveCount() - 1);
          break;
        case 'ArrowRight':
          event.preventDefault();
          goToPly(state.game.moveCount() + 1);
          break;
        case 'Home':
          event.preventDefault();
          goToPly(0);
          break;
        case 'End':
          event.preventDefault();
          goToPly(totalPlies());
          break;
        case 'f':
        case 'F':
          flip();
          break;
        default:
          break;
      }
    });
  }

  function flip() {
    state.orientation = state.orientation === 'w' ? 'b' : 'w';
    render();
  }

  function init() {
    cacheElements();
    restore();
    buildBoard();
    bindEvents();
    el.showCoords.checked = state.showCoords;
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
