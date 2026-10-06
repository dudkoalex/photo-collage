/* ============================================================
 * Движок фотоколлажа. Только ES5 — без модулей, fetch, Promise.
 *
 * Раскладка 'snake' («змейка», по умолчанию), 3 столбца:
 *   1-й столбец: сверху ячейка-ссылка на ПРЕДЫДУЩУЮ страницу
 *      (фон — последнее фото той страницы), снизу — на СЛЕДУЮЩУЮ
 *      (фон — первое фото той страницы).
 *   2-й столбец: портретное фото этой страницы (во всю высоту).
 *   3-й столбец: сверху фото ближе к формату 4:3, снизу —
 *      статистика «просмотрено X из Y» и большие кнопки [−][+].
 * Страница = 2 фото (портретный пул + пул 4:3), дублей нет.
 * Переходы: слайды уезжают по траектории змейки со stagger.
 *
 * Раскладки 2/3/4 (grid2x2, grid3x3, single) — «лента»: ВСЕ фото
 * одной длинной вертикальной сеткой. Прокрутка — колесом мыши и
 * «курсором» с пульта: стрелки двигают выделенную ячейку (экран
 * доскролливается), OK открывает страницу «змейки» с этим фото,
 * Esc переключает стрелки в режим свободной прокрутки. Видимые
 * ячейки лениво апгрейдятся с миниатюр на полноразмерные копии.
 *
 * Пульт в «змейке»: стрелки двигают фокус по ячейкам/кнопкам,
 * OK нажимает; без фокуса стрелки листают страницы, OK — фокус
 * на первую ячейку. Esc/Back — снять фокус. P/пробел — пауза,
 * 1–4 — раскладки, M — плейлист.
 * ============================================================ */

(function () {
  'use strict';

  var SNAKE_PAGE = 2;
  var THUMB_COUNT = 5;

  var LAYOUTS = {
    'snake':   { snake: true },
    'magazine':{ magazine: true },   // унаследованная, вне меню
    'grid2x2': { tape: true, mode2: true, cols: 3, rowsPerScreen: 2 },
    'grid3x3': { tape: true, mode3: true, linearNav: true },
    'single':  { tape: true, cols: 1, rowsPerScreen: 1, fit: true }
  };

  function isTape() {
    return !!(LAYOUTS[state.layoutName] && LAYOUTS[state.layoutName].tape);
  }
  function isSnake() {
    return !!(LAYOUTS[state.layoutName] && LAYOUTS[state.layoutName].snake);
  }

  var state = {
    started: false,
    paused: false,
    photos: [],
    portPool: [],
    landPool: [],
    page: 0,
    pageCount: 1,
    maxPageSeen: 0,
    layoutName: 'snake',
    intervalSec: 10,
    fadeSec: 0.9,
    playlistName: null,
    timerId: null,
    scenarioTimerId: null,
    scenarioSteps: null,
    scenarioPos: 0,
    cells: [],
    focusables: [],
    lastDirection: 1,
    // лента
    cursorIdx: 0,
    freeScroll: false,
    upgradeTimerId: null,
    // устройство/пульт
    isTouch: false,
    throttleUntil: 0,
    gateDismissed: false
  };

  /* ---------- утилиты ---------- */

  function showMsg(text) {
    var el = document.getElementById('msg');
    if (!el) { return; }
    el.style.display = text ? 'block' : 'none';
    el.innerHTML = text || '';
  }

  function mod(i, n) { return ((i % n) + n) % n; }

  function collageEl() { return document.getElementById('collage'); }

  /* ---------- слои и переходы ---------- */

  function applyTransition(layer) {
    var v = state.fadeSec + 's ease-in-out';
    var t = 'opacity ' + v + ', -webkit-transform ' + v + ', transform ' + v;
    layer.style.webkitTransition = t;
    layer.style.transition = t;
  }

  function noTransition(el) {
    el.style.webkitTransition = 'none';
    el.style.transition = 'none';
  }

  function setTransform(el, vec) {
    var v = vec ? 'translate(' + vec[0] + '%, ' + vec[1] + '%)' : '';
    el.style.webkitTransform = v;
    el.style.transform = v;
  }

  /* ---------- построение раскладки ---------- */

  function makeCell(host, left, top, width, height, kind, opts) {
    opts = opts || {};
    var cell = document.createElement('div');
    cell.className = 'cell' + (opts.cls ? ' ' + opts.cls : '');
    var unit = opts.px ? 'px' : '%';
    cell.style.left = left + unit;
    cell.style.top = top + unit;
    cell.style.width = width + unit;
    cell.style.height = height + unit;

    var layers = [];
    if (!opts.noLayer) {
      for (var i = 0; i < 2; i++) {
        var layer = document.createElement('div');
        layer.className = 'layer';
        if (opts.fit) {
          // вписать фото целиком: максимум площади без переполнения
          layer.style.backgroundSize = 'contain';
          layer.style.webkitBackgroundSize = 'contain';
        }
        applyTransition(layer);
        cell.appendChild(layer);
        layers.push(layer);
      }
    }
    if (opts.label !== undefined) {
      var lab = document.createElement('div');
      lab.className = 'navlabel';
      lab.innerHTML = opts.label;
      cell.appendChild(lab);
    }
    host.appendChild(cell);
    var rec = {
      el: cell, layers: layers, active: 0, src: null,
      kind: kind, big: !opts.small
    };
    state.cells.push(rec);
    return rec;
  }

  function buildCells() {
    var host = collageEl();
    host.innerHTML = '';
    host.className = '';
    state.cells = [];
    state.focusables = [];
    state.freeScroll = false;

    var layout = LAYOUTS[state.layoutName] || LAYOUTS.snake;

    if (isSnake()) {
      buildSnake(host);
    } else if (layout.magazine) {
      buildMagazine(host);
    } else if (layout.tape) {
      buildTape(host, layout);
    }
  }

  function buildSnake(host) {
    var vh = host.clientHeight || 720;
    // столбец 1: один flex-родитель — нав-эскизы (блок 70% высоты
    // по центру) + счётчик фото внизу с запасом места под надпись
    var col = document.createElement('div');
    col.style.cssText =
      'position:absolute;left:0;top:0;width:14%;height:100%;' +
      'display:-webkit-flex;display:flex;' +
      '-webkit-flex-direction:column;flex-direction:column;';
    host.appendChild(col);

    var cPrev = makeCell(col, 0, 0, 100, 35, 'navPrev',
      { cls: 'navcell focusable', small: true, label: '' });
    var cNext = makeCell(col, 0, 0, 100, 35, 'navNext',
      { cls: 'navcell focusable', small: true, label: '' });
    cPrev.el.setAttribute('tabindex', '0');
    cNext.el.setAttribute('tabindex', '0');
    cPrev.el.onclick = function () { hideTouchMenu(); throttledPageAction(function () { state.lastDirection = -1; api.prevPage(); }); };
    cNext.el.onclick = function () { hideTouchMenu(); throttledPageAction(function () { state.lastDirection = 1; api.nextPage(); }); };
    state.focusables.push(cPrev.el, cNext.el);

    // эскизы — флекс-элементы; над и под блоком по 15% пустоты
    function flexize(el, basis) {
      el.style.position = 'relative';
      el.style.left = '0';
      el.style.top = '0';
      el.style.width = '100%';
      el.style.height = basis;
      el.style.webkitFlex = '0 0 ' + basis;
      el.style.flex = '0 0 ' + basis;
    }
    flexize(cPrev.el, '35%');
    flexize(cNext.el, '35%');
    var spTop = document.createElement('div');
    spTop.style.cssText = '-webkit-flex:0 0 15%;flex:0 0 15%;';
    var spMid = document.createElement('div');
    spMid.style.cssText = '-webkit-flex:1 1 auto;flex:1 1 auto;';
    col.appendChild(spTop);
    col.appendChild(cPrev.el);
    col.appendChild(cNext.el);
    col.appendChild(spMid);

    // счётчик «N из M фото» — внизу столбца, с запасом под две строки
    var seen = document.createElement('div');
    seen.className = 'seenbox';
    seen.style.cssText =
      'position:relative;-webkit-flex:0 0 auto;flex:0 0 auto;' +
      'padding:6px 3px 8px;' +
      'font-size:' + Math.max(15, Math.min(20, Math.round(vh * 0.032))) + 'px;';
    seen.innerHTML =
      '<div class="seenico">&#128247;</div>' +   // пиктограмма «фото»
      '<span id="stLine1"></span><div class="bar"><i id="stBar"></i></div>';
    col.appendChild(seen);

    // столбец 2: портрет во всю высоту
    makeCell(host, 14, 0, 32, 100, 'portrait');

    // столбец 3: сверху 4:3 (выше — лёгкий кроп по горизонтали),
    // снизу компактная статистика
    makeCell(host, 46, 0, 54, 78, 'four3');
    var stats = makeCell(host, 46, 78, 54, 22, 'stats', { noLayer: true });
    buildStats(stats.el);
  }

  function buildMagazine(host) {
    makeCell(host, 0, 0, 33, 100, 'portrait');
    makeCell(host, 33, 0, 67, 55, 'landscape');
    var tw = 67 / (THUMB_COUNT + 1);
    for (var i = 0; i < THUMB_COUNT; i++) {
      makeCell(host, 33 + i * tw, 55, tw, 45, 'thumb', { small: true });
    }
    makeCell(host, 33 + THUMB_COUNT * tw, 55, tw, 45, 'prev', { small: true });
  }

  /* ---------- лента (grid2x2 / grid2x3 / grid3x3 / single) ----------
   * Все фото одной длинной сеткой в скроллящемся контейнере.
   * Ячейки позиционируются в пикселях (проценты от высоты ленты
   * посчитать нельзя — лента длиннее экрана).
   *
   * Адаптив под пропорции: первый (левый) столбец — под портретные
   * фото, его ширина = высота ячейки × среднее w/h портретов
   * (зажата в 15–35% ширины экрана); правые столбцы делят остаток.
   * Заполнение: портреты идут в левый столбец, альбомные — в правые;
   * излишек (когда одного вида больше, чем слотов) догружается
   * в оставшиеся слоты противоположной зоны — без дублей.
   */
  function buildTape(host, layout) {
    host.className = 'tape-mode';

    var tape = document.createElement('div');
    tape.id = 'tape';
    host.appendChild(tape);

    if (layout.mode2) {
      buildTapeMode2(tape, host);
      state.cursorIdx = 0;
      state.freeScroll = false;
      setCursor(0, false);
      scheduleUpgrade();
      return;
    }
    if (layout.mode3) {
      buildTapeMode3(tape, host);
      state.cursorIdx = 0;
      state.freeScroll = false;
      setCursor(0, false);
      scheduleUpgrade();
      return;
    }

    var vw = host.clientWidth || 1280;
    var vh = host.clientHeight || 720;
    var cols = layout.cols;
    var ch = Math.floor(vh / layout.rowsPerScreen);
    var n = state.photos.length;

    var rows = Math.ceil(n / cols);
    tape.style.height = (rows * ch) + 'px';

    // адаптивные ширины столбцов
    var colW = [], c;
    if (cols > 1) {
      var sumR = 0, i;
      for (i = 0; i < state.portPool.length; i++) { sumR += state.portPool[i].r; }
      var avgP = state.portPool.length ? (sumR / state.portPool.length) : 0.667;
      var w0 = Math.round(ch * avgP);
      if (w0 < vw * 0.15) { w0 = Math.round(vw * 0.15); }
      if (w0 > vw * 0.35) { w0 = Math.round(vw * 0.35); }
      colW[0] = w0;
      var wRest = Math.floor((vw - w0) / (cols - 1));
      for (c = 1; c < cols; c++) { colW[c] = wRest; }
    } else {
      colW[0] = vw;
    }

    // порядок заполнения: левый столбец — портреты, правые — альбомные
    var col0List = (cols === 1)
      ? state.photos.slice()
      : state.portPool.slice(0, rows);
    var restList = (cols === 1)
      ? []
      : state.landPool.concat(state.portPool.slice(rows));

    for (var r = 0; r < rows; r++) {
      var x = 0;
      for (c = 0; c < cols; c++) {
        var left = x;
        x += colW[c];
        var photo = (c === 0) ? col0List[r] : restList[r * (cols - 1) + (c - 1)];
        if (!photo) { continue; }  // слотов больше, чем фото — пусто
        var gS = gridMetrics(host).gap;
        tapePlace(tape, photo, left + gS, r * ch + gS, colW[c] - 2 * gS, ch - 2 * gS);
      }
    }

    state.cursorIdx = 0;
    state.freeScroll = false;
    setCursor(0, false);
    scheduleUpgrade();
  }

  /* ---------- режим 2 («экран»): 1 портрет + 2 альбомных ----------
   * Один экран ленты: слева ОДНА вертикальная фотография на всю
   * высоту экрана — ширина её ячейки = высота × пропорция этого
   * конкретного фото (без обрезки). Справа — две альбомные стопкой,
   * ширина = полвысоты × средняя пропорция альбомных. Композиция
   * центрируется по горизонтали; сетку НЕ растягиваем на 100% —
   * остаток остаётся чёрным фоном.
   * Порядок ячеек на экране: портрет, альбомная 1, альбомная 2 —
   * курсор ходит по ним как по строке из 3 элементов.
   */
  function buildTapeMode2(tape, host) {
    var vw = host.clientWidth || 1280;
    var vh = host.clientHeight || 720;
    var P = state.portPool, L = state.landPool;
    var screens = Math.max(P.length, Math.ceil(L.length / 2), 1);
    tape.style.height = (screens * vh) + 'px';

    var i, sumR = 0;
    for (i = 0; i < L.length; i++) { sumR += (L[i].r || 1.5); }
    var avgL = L.length ? (sumR / L.length) : 1.333;
    var g = gridMetrics(host).gap;
    var halfH = Math.floor((vh - 3 * g) / 2);
    var wL = Math.round(halfH * avgL);
    if (wL > vw * 0.6) { wL = Math.round(vw * 0.6); }
    var fullH = vh - 2 * g;

    for (var s = 0; s < screens; s++) {
      var p = P[s];
      var wP = p ? Math.round(fullH * (p.r || 0.667)) : 0;
      var contentW = wP ? (wP + g + wL) : wL;
      var x0 = Math.max(g, Math.round((vw - contentW) / 2));
      var y = s * vh;

      if (p) { tapePlace(tape, p, x0, y + g, wP, fullH); }
      for (var j = 0; j < 2; j++) {
        var l = L[s * 2 + j];
        if (!l) { break; }
        tapePlace(tape, l, x0 + wP + g, y + g + j * (halfH + g), wL, halfH);
      }
    }
  }

  /* ---------- режим 3: два столбца на всю ширину (без полей) ----------
   * Экран — либо ОБА столбца со стопкой из двух альбомных фото,
   * либо ОБА с одним вертикальным фото. Выбор на каждый экран —
   * по балансу пулов: чего осталось больше, то и на экране.
   * Если один пул закончился, слоты добираются из другого.
   */
  function buildTapeMode3(tape, host) {
    var vw = host.clientWidth || 1280;
    var vh = host.clientHeight || 720;
    var P = state.portPool.slice(), L = state.landPool.slice();
    var halfH = Math.floor(vh / 2);
    var halfW = Math.floor(vw / 2);


    var g = gridMetrics(host).gap;
    var fullH = vh - 2 * g;
    var y = 0;
    while (P.length > 0 || L.length > 0) {
      var usePortraits;
      if (P.length === 0) { usePortraits = false; }
      else if (L.length === 0) { usePortraits = true; }
      else { usePortraits = P.length >= L.length; }

      if (usePortraits) {
        // экран из двух вертикальных: ширина от пропорции фото,
        // высота — вьюпорт минус гэпы; пара центрируется
        var p1 = P.length ? P.shift() : L.shift();
        var p2 = P.length ? P.shift() : L.shift();
        var w1 = p1 ? Math.round(fullH * (p1.r || 0.667)) : 0;
        var w2 = p2 ? Math.round(fullH * (p2.r || 0.667)) : 0;
        var avail = vw - 3 * g;
        if (w1 + w2 > avail && w1 + w2 > 0) {
          var k = avail / (w1 + w2);
          w1 = Math.round(w1 * k);
          w2 = Math.round(w2 * k);
        }
        var x1 = Math.round(g + (avail - w1 - g - w2) / 2);
        if (p1) { tapePlace(tape, p1, x1, y + g, w1, fullH); }
        if (p2) { tapePlace(tape, p2, x1 + w1 + g, y + g, w2, fullH); }
      } else {
        // экран из двух стопок альбомных
        var cw = Math.floor((vw - 3 * g) / 2);
        var chh = Math.floor((vh - 3 * g) / 2);
        tapePlace(tape, L.length ? L.shift() : P.shift(), g, y + g, cw, chh);
        tapePlace(tape, L.length ? L.shift() : P.shift(), g, y + g + chh + g, cw, chh);
        tapePlace(tape, L.length ? L.shift() : P.shift(), g + cw + g, y + g, cw, chh);
        tapePlace(tape, L.length ? L.shift() : P.shift(), g + cw + g, y + g + chh + g, cw, chh);
      }
      y += vh;
    }
    tape.style.height = y + 'px';
  }


  /* ---------- метрики сетки: отступы/закругления ----------
   * Мобильный экран (vh < 500) — тонкие отступы без закруглений;
   * десктоп (500–999) — классические 14px и радиус 10px;
   * ТВ/крупный экран (>= 1000) — 24px и радиус 12px.
   */
  function gridMetrics(host) {
    var vh = (host || collageEl()).clientHeight || 720;
    if (vh < 500) { return { gap: 5, radius: 0 }; }
    if (vh < 1000) { return { gap: 14, radius: 10 }; }
    return { gap: 24, radius: 12 };
  }

  /* ---------- ячейка ленты: ленивые миниатюры + предзагрузка ----------
   * Миниатюра ставится только ячейкам в пределах двух экранов от
   * верха/текущей позиции — остальным по мере приближения
   * (upgradeVisible). Вместе с миниатюрой полная версия становится
   * в очередь предзагрузки (2 одновременно), чтобы при апгрейде
   * показать её мгновенно из кэша.
   */

  function tapePlace(tape, photo, x, y, w, h) {
    if (!photo) { return; }   // пулы закончились посреди экрана
    var vh = collageEl().clientHeight || 720;
    var rec = makeCell(tape, x, y, w, h, 'tape',
      { px: true, fit: !!(LAYOUTS[state.layoutName] && LAYOUTS[state.layoutName].fit) });
    var gm = gridMetrics();
    if (gm.radius) {
      rec.el.style.webkitBorderRadius = gm.radius + 'px';
      rec.el.style.borderRadius = gm.radius + 'px';
    }
    rec.photoIndex = state.photos.indexOf(photo);
    rec.upgraded = false;
    rec.tapeTop = y;
    if (y < vh * 2) {
      rec.layers[0].style.backgroundImage = 'url("' + photo.thumb + '")';
      rec.layers[0].className = 'layer visible';
      rec.src = photo.thumb;
    }
    queueMidPreload(photo);
  }

  var preQueue = [], preActive = 0;
  // priority=true — видимая ячейка: в голову очереди
  function queueMidPreload(photo, priority) {
    if (!photo || photo._midQueued) { return; }
    photo._midQueued = true;
    if (priority) { preQueue.unshift(photo); } else { preQueue.push(photo); }
    pumpPreload();
  }
  function pumpPreload() {
    while (preActive < 2 && preQueue.length > 0) {
      var p = preQueue.shift();
      if (p._midLoaded) { continue; }
      preActive++;
      var im = new Image();
      im.onload = function () {
        p._midLoaded = true;      // теперь апгрейд мгновенный
        preActive--;
        pumpPreload();
        scheduleUpgrade();        // видимые ячейки могут апгрейдиться
      };
      im.onerror = function () {
        p._midLoaded = true;      // битая — не держим очередь
        preActive--;
        pumpPreload();
      };
      im.src = p.mid;
    }
  }

  // ленивый апгрейд видимых ячеек: thumb -> mid
  function scheduleUpgrade() {
    if (state.upgradeTimerId !== null) { clearTimeout(state.upgradeTimerId); }
    state.upgradeTimerId = setTimeout(upgradeVisible, 250);
  }

  function upgradeVisible() {
    if (!isTape()) { return; }
    var host = collageEl();
    var st = host.scrollTop;
    var vh = host.clientHeight || 720;
    var dirty = false;
    var i, cell;
    for (i = 0; i < state.cells.length; i++) {
      cell = state.cells[i];
      if (cell.kind !== 'tape') { continue; }
      // ячейка в пределах экрана сверху/снизу
      if (cell.tapeTop + 100 > st - vh * 0.5 && cell.tapeTop < st + vh * 1.5) {
        if (!cell.src) {
          // ещё без миниатюры — ставим её, полную очередь подхватит
          var ph = state.photos[cell.photoIndex];
          cell.layers[0].style.backgroundImage = 'url("' + ph.thumb + '")';
          cell.layers[0].className = 'layer visible';
          cell.src = ph.thumb;
          queueMidPreload(ph);
          dirty = true;
        } else if (!cell.upgraded) {
          var mp = state.photos[cell.photoIndex];
          if (mp._midLoaded) {
            // полный размер уже в кэше — меняем без докачки
            cell.upgraded = true;
            setCellImage(cell, mp.mid, 0);
            dirty = true;
          } else {
            // ещё грузится: продвигаем в голову очереди и ждём
            queueMidPreload(mp, true);
          }
        }
      }
    }
    if (dirty) { scheduleUpgrade(); }
  }

  /* ---------- курсор ленты (навигация пультом) ---------- */

  function setCursor(i, scroll) {
    var old = state.cells[state.cursorIdx];
    if (old) { old.el.className = old.el.className.replace(' cursorcell', ''); }
    state.cursorIdx = i;
    var cell = state.cells[i];
    if (!cell) { return; }
    if (!state.freeScroll) { cell.el.className += ' cursorcell'; }
    if (scroll !== false && cell.el.scrollIntoView) {
      try { cell.el.scrollIntoView(false); } catch (e) {}
    }
  }

  function moveCursor(dx, dy) {
    var layout = LAYOUTS[state.layoutName];
    if (!layout || !layout.tape) { return; }
    var n = state.cells.length;
    var i = state.cursorIdx;

    // режим 3: раскладка не табличная — навигация линейная
    if (layout.linearNav) {
      var d = dx || dy;
      i = Math.max(0, Math.min(n - 1, i + d));
      setCursor(i);
      return;
    }

    var cols = layout.cols;
    if (dx) {
      var row = Math.floor(i / cols), col = i % cols + dx;
      if (col < 0 || col >= cols) { return; }
      i = row * cols + col;
    } else if (dy) {
      i += dy * cols;
    }
    if (i < 0 || i >= n) { return; }
    setCursor(i);
  }

  // OK на ячейке ленты: открыть страницу «змейки» с этим фото
  function activateCursor() {
    var cell = state.cells[state.cursorIdx];
    if (!cell || cell.kind !== 'tape') { return; }
    var photo = state.photos[cell.photoIndex];
    var page = state.portPool.indexOf(photo);
    if (page === -1) { page = state.landPool.indexOf(photo); }
    if (page === -1) { return; }
    state.lastDirection = 1;
    api.setLayout('snake');
    api.setPage(page + 1);
  }

  /* ---------- блок статистики (правый нижний, змейка) ---------- */

  function buildStats(host) {
    // размеры кнопок/шрифтов — от фактической высоты панели,
    // чтобы на низких экранах ничего не резалось
    var h = host.clientHeight || 160;
    var btn = Math.max(34, Math.min(64, Math.round(h * 0.52)));
    var fnum = Math.max(17, Math.round(btn * 0.42));
    var fpause = Math.max(14, Math.round(btn * 0.3));
    host.innerHTML =
      '<div class="stats" id="statsBox">' +
        '<div class="pager">' +
          '<button id="pgPrev" type="button" style="width:' + btn + 'px;height:' + btn + 'px;line-height:' + btn + 'px;font-size:' + Math.round(btn * 0.55) + 'px;">&minus;</button>' +
          '<span class="pagenum" id="pgNum" style="font-size:' + fnum + 'px;min-width:' + (btn * 2.6) + 'px;"></span>' +
          '<button id="pgNext" type="button" style="width:' + btn + 'px;height:' + btn + 'px;line-height:' + btn + 'px;font-size:' + Math.round(btn * 0.55) + 'px;">+</button>' +
        '</div>' +
        '<div class="pausemark" id="stPause" style="height:' + Math.round(btn * 0.4) + 'px;font-size:' + Math.max(16, fpause) + 'px;cursor:pointer;"></div>' +
      '</div>';
    var bPrev = host.getElementsByTagName('button')[0];
    var bNext = host.getElementsByTagName('button')[1];
    bPrev.onclick = function () { throttledPageAction(function () { state.lastDirection = -1; api.prevPage(); }); };
    bNext.onclick = function () { throttledPageAction(function () { state.lastDirection = 1; api.nextPage(); }); };
    state.focusables.push(bPrev, bNext);
    // тап/фокус по метке — переключить паузу (иначе непонятно, как снять)
    var pauEl = document.getElementById('stPause');
    if (pauEl) {
      pauEl.setAttribute('tabindex', '0');
      pauEl.className += ' focusable';
      pauEl.onclick = function () {
        if (state.paused) { api.resume(); } else { api.pause(); }
      };
      state.focusables.push(pauEl);
    }
  }

  function updateStats() {
    var l1 = document.getElementById('stLine1');
    if (!l1) { return; }
    var bar = document.getElementById('stBar');
    var num = document.getElementById('pgNum');
    var pau = document.getElementById('stPause');
    var seen = Math.min((state.maxPageSeen + 1) * SNAKE_PAGE, state.photos.length);
    l1.innerHTML = seen + ' из ' + state.photos.length;
    bar.style.width = Math.round(seen / state.photos.length * 100) + '%';
    // пиктограмма раскладки + текущая страница (общее число)
    num.innerHTML = '&#9638; ' + (state.page + 1) + ' <small>(' + state.pageCount + ')</small>';
    pau.innerHTML = state.paused
      ? '&#9208; пауза'
      : '<span style="opacity:.45">&#9654; пауза</span>';
  }

  /* ---------- кроссфейд/сдвиг ячейки ---------- */

  var SNAKE_VEC = {
    navPrev:  { in: [-80, 0], out: [0, 80] },
    navNext:  { in: [-80, 0], out: [0, 80] },
    portrait: { in: [0, 80],  out: [0, -80] },
    four3:    { in: [0, -80], out: [80, 0] }
  };

  function setCellImage(cell, url, dir) {
    if (!cell || !url || cell.src === url) { return; }
    var next = 1 - cell.active;
    var inL = cell.layers[next];
    var outL = cell.layers[cell.active];

    var vec = null;
    if (dir && SNAKE_VEC[cell.kind]) {
      vec = SNAKE_VEC[cell.kind];
      if (dir < 0) {
        vec = { in: [-vec.in[0], -vec.in[1]], out: [-vec.out[0], -vec.out[1]] };
      }
    }

    inL.style.backgroundImage = 'url("' + url + '")';
    if (vec) {
      noTransition(inL);
      setTransform(inL, vec.in);
    }
    setTimeout(function () {
      if (vec) { applyTransition(inL); }
      inL.className = 'layer visible';
      if (vec) { setTransform(inL, [0, 0]); }
      if (outL.style.backgroundImage) {
        outL.className = 'layer';
        if (vec) { setTransform(outL, vec.out); }
      }
      cell.active = next;
      cell.src = url;
      if (vec) {
        setTimeout(function () {
          if (outL.className.indexOf('visible') === -1) { setTransform(outL, null); }
        }, state.fadeSec * 1000 + 400);
      }
    }, 40);
  }

  /* ---------- состав страницы «змейки» ---------- */

  function snakePlan() {
    var s = state;
    var P = s.portPool.length, L = s.landPool.length;
    var portrait, four;

    if (P > 0) { portrait = s.portPool[s.page % P]; }
    if (L > 0) { four = s.landPool[s.page % L]; }

    if (!portrait && !four) { portrait = s.photos[0]; four = s.photos[0]; }
    if (!portrait) { portrait = (four !== s.landPool[(s.page + 1) % L]) ? s.landPool[(s.page + 1) % L] : s.landPool[(s.page + 2) % L]; }
    if (!four)     { four = (portrait !== s.portPool[(s.page + 1) % P]) ? s.portPool[(s.page + 1) % P] : s.portPool[(s.page + 2) % P]; }

    var prevPageNum = mod(s.page - 1, s.pageCount) + 1;
    var nextPageNum = mod(s.page + 1, s.pageCount) + 1;
    var prevPhoto = (L > 0) ? s.landPool[mod(s.page - 1, L)] : portrait;
    var nextPhoto = (P > 0) ? s.portPool[mod(s.page + 1, P)] : four;

    return {
      navPrevPhoto: prevPhoto,
      navNextPhoto: nextPhoto,
      portrait: portrait,
      four3: four,
      prevPageNum: prevPageNum,
      nextPageNum: nextPageNum
    };
  }

  /* ---------- отрисовка страницы ---------- */

  function renderPage() {
    if (isTape()) { return; }  // лента рендерится при построении
    var dir = state.lastDirection;
    var i, cell, item;

    if (isSnake()) {
      var plan = snakePlan();
      var order = ['navPrev', 'navNext', 'portrait', 'four3'];
      for (i = 0; i < state.cells.length; i++) {
        cell = state.cells[i];
        var idx = order.indexOf(cell.kind);
        if (idx === -1) { continue; }
        item = {
          navPrev: { url: plan.navPrevPhoto && plan.navPrevPhoto.thumb },
          navNext: { url: plan.navNextPhoto && plan.navNextPhoto.thumb },
          portrait: { url: plan.portrait && plan.portrait.mid },
          four3: { url: plan.four3 && plan.four3.mid }
        }[cell.kind];
        if (!item || !item.url) { continue; }
        scheduleSwap(cell, item.url, idx, dir);
      }
      setLabels(plan);
      fadeStats();
    } else {
      // magazine/устаревшие сетки-страницы
      var len = state.photos.length;
      var per = 7;
      var start = state.page * per;
      for (i = 0; i < state.cells.length; i++) {
        cell = state.cells[i];
        item = state.photos[mod(start + i, len)];
        if (!item) { continue; }
        var url = (cell.kind === 'thumb' || cell.kind === 'prev') ? item.thumb : item.mid;
        setCellImage(cell, url, 0);
      }
    }
    updateStats();
  }

  function scheduleSwap(cell, url, orderIdx, dir) {
    var delay = 40 + orderIdx * 150;
    (function (c, u, d) {
      setTimeout(function () { setCellImage(c, u, d); }, delay);
    })(cell, url, dir);
  }

  function setLabels(plan) {
    var cells = state.cells;
    for (var i = 0; i < cells.length; i++) {
      var lab = cells[i].el.getElementsByTagName('div');
      for (var k = 0; k < lab.length; k++) {
        if (lab[k].className === 'navlabel') {
          lab[k].innerHTML = (cells[i].kind === 'navPrev')
            ? '&#9664; стр. ' + plan.prevPageNum
            : 'стр. ' + plan.nextPageNum + ' &#9654;';
        }
      }
    }
  }

  function fadeStats() {
    var box = document.getElementById('statsBox');
    if (!box) { return; }
    box.style.opacity = '0';
    setTimeout(function () {
      updateStats();
      box.style.opacity = '1';
    }, state.fadeSec * 500);
  }

  /* ---------- таймер страниц (только «змейка») ---------- */

  function restartTimer() {
    if (state.timerId !== null) {
      clearInterval(state.timerId);
      state.timerId = null;
    }
    if (!isSnake() || state.photos.length === 0 || state.pageCount <= 1) { return; }
    state.timerId = setInterval(function () {
      if (state.paused) { return; }
      state.lastDirection = 1;
      api.nextPage();
      hideTouchMenu(); // меню прячется после хода слайдшоу
    }, Math.max(1, state.intervalSec) * 1000);
  }

  // предзагрузка полных версий для страниц змейки [page-1 .. page+2]:
  // к моменту перелистывания фото уже в кэше — анимация без докачки
  function preloadSnakeWindow() {
    if (!isSnake()) { return; }
    var P = state.portPool, L = state.landPool;
    var i, pg;
    for (i = -1; i <= 2; i++) {
      pg = mod(state.page + i, state.pageCount);
      if (P.length) { queueMidPreload(P[pg % P.length], i <= 0); }
      if (L.length) { queueMidPreload(L[pg % L.length], i <= 0); }
    }
  }

  function gotoPage(n) {
    state.page = mod(n, state.pageCount);
    if (state.page > state.maxPageSeen) { state.maxPageSeen = state.page; }
    preloadSnakeWindow();
    renderPage();
  }

  /* ---------- сценарий ---------- */

  function runScenarioStep() {
    if (!state.scenarioSteps || state.scenarioSteps.length === 0) { return; }
    var step = state.scenarioSteps[state.scenarioPos];
    state.scenarioPos = (state.scenarioPos + 1) % state.scenarioSteps.length;

    var delay = (typeof step.delay === 'number' && step.delay > 0) ? step.delay : 10;
    state.scenarioTimerId = setTimeout(function () {
      var args = step.args || [];
      var fn = null;
      if (step.action === 'setLayout')   { fn = api.setLayout; }
      if (step.action === 'setInterval') { fn = api.setIntervalSec; }
      if (step.action === 'setPlaylist') { fn = api.setPlaylist; }
      if (step.action === 'nextPage')    { fn = api.nextPage; }
      if (step.action === 'prevPage')    { fn = api.prevPage; }
      if (step.action === 'setPage')     { fn = api.setPage; }
      if (step.action === 'pause')       { fn = api.pause; }
      if (step.action === 'resume')      { fn = api.resume; }
      if (fn) { try { fn.apply(api, args); } catch (e) {} }
      runScenarioStep();
    }, delay * 1000);
  }

  /* ---------- фокус (навигация пультом, «змейка») ---------- */

  function focusIdx() {
    var el = document.activeElement, i;
    for (i = 0; i < state.focusables.length; i++) {
      if (state.focusables[i] === el) { return i; }
    }
    return -1;
  }

  function moveFocus(step) {
    var i = focusIdx();
    if (i === -1) {
      i = (step > 0) ? 0 : state.focusables.length - 1;
    } else {
      i = mod(i + step, state.focusables.length);
    }
    var el = state.focusables[i];
    if (el && el.focus) { try { el.focus(); } catch (e) {} }
  }

  function clearFocus() {
    if (document.activeElement && document.activeElement.blur) {
      try { document.activeElement.blur(); } catch (e) {}
    }
  }

  /* ---------- публичный API ---------- */

  var api = {
    init: function () {
      if (state.started) { return; }
      state.started = true;

      var cfg = (typeof COLLAGE_CONFIG !== 'undefined') ? COLLAGE_CONFIG : null;
      if (!cfg) { showMsg('config.js не найден'); return; }

      state.playlistName = cfg.activePlaylist;
      var list = cfg.playlists && cfg.playlists[state.playlistName];
      if (!list || list.length === 0) {
        showMsg('Нет фотографий: впишите пути в config.js (playlists)');
        return;
      }
      state.photos = list.slice();
      normalizePhotos();

      var o = cfg.options || {};
      // авто-выбор раскладки по типу устройства: без тача (ТВ/десктоп)
      // — режим 2, с тачем — режим 1 «змейка»; config.layout больше
      // не дефолт, его можно наложить вручную через Collage.setLayout
      state.isTouch = isTouchDevice();
      state.layoutName = state.isTouch ? 'snake' : 'grid2x2';
      state.intervalSec = (typeof o.intervalSec === 'number') ? o.intervalSec : 10;
      state.fadeSec = (typeof o.fadeSec === 'number' && o.fadeSec > 0.2) ? o.fadeSec : 0.9;

      recalcPages();
      state.page = 0;
      state.maxPageSeen = 0;

      buildCells();
      renderPage();
      preloadSnakeWindow();
      restartTimer();
      initScroll();
      initRemoteKeys();
      initResize();
      // меню раскладок — на всех устройствах, живёт на полях справа;
      // гейт поворота и свайпы — только там, где есть тач
      initTouchUI();
      initUpdateWatch();
    },

    nextPage: function () { gotoPage(state.page + 1); },
    prevPage: function () { gotoPage(state.page - 1); },
    setPage: function (n) { gotoPage(n - 1); },
    next: function () { state.lastDirection = 1; gotoPage(state.page + 1); },
    prev: function () { state.lastDirection = -1; gotoPage(state.page - 1); },

    pause: function () { state.paused = true; updateStats(); },
    resume: function () { state.paused = false; updateStats(); },

    setIntervalSec: function (sec) {
      state.intervalSec = (typeof sec === 'number' && sec >= 1) ? sec : 10;
      restartTimer();
    },

    setLayout: function (name) {
      if (!LAYOUTS[name]) { return; }
      state.layoutName = name;
      recalcPages();
      state.page = Math.min(state.page, state.pageCount - 1);
      clearFocus();
      var st = collageEl().scrollTop;
      buildCells();
      // в ленте возвращаем прокрутку пропорционально
      if (isTape()) {
        collageEl().scrollTop = st;
        scheduleUpgrade();
      } else {
        renderPage();
        preloadSnakeWindow();
      }
      restartTimer();
    },

    setPlaylist: function (name) {
      var cfg = (typeof COLLAGE_CONFIG !== 'undefined') ? COLLAGE_CONFIG : null;
      if (!cfg || !cfg.playlists || !cfg.playlists[name]) { return; }
      state.playlistName = name;
      state.photos = cfg.playlists[name].slice();
      normalizePhotos();
      recalcPages();
      state.page = 0;
      state.maxPageSeen = 0;
      buildCells();
      renderPage();
      restartTimer();
    },

    showPanel: function () { showTouchMenu(); },
    hidePanel: function () { hideTouchMenu(); },

    playScenario: function (steps) {
      if (state.scenarioTimerId !== null) {
        clearTimeout(state.scenarioTimerId);
        state.scenarioTimerId = null;
      }
      if (!steps || !steps.length) { return; }
      state.scenarioSteps = steps;
      state.scenarioPos = 0;
      runScenarioStep();
    },

    stopScenario: function () {
      if (state.scenarioTimerId !== null) {
        clearTimeout(state.scenarioTimerId);
        state.scenarioTimerId = null;
      }
      state.scenarioSteps = null;
    },

    _state: state,
    _touchui: function () { initTouchUI(); }
  };

  /* ---------- устройство: тач-детект, гейт, меню, свайп ---------- */

  function isTouchDevice() {
    return ('ontouchstart' in window) ||
      (typeof document.documentElement.ontouchstart !== 'undefined') ||
      (typeof navigator.maxTouchPoints === 'number' && navigator.maxTouchPoints > 0);
  }

  function initTouchUI() {
    if (state.isTouch) {
      updateGate();
      var skip = document.getElementById('gateSkip');
      if (skip) {
        skip.onclick = function () {
          state.gateDismissed = true;
          updateGate();
        };
      }
    }
    buildTouchMenu();
    if (state.isTouch) { initSwipe(); initTapMenu(); }
  }

  // гейт: в портретной ориентации занимаем экран анимацией поворота
  // (только тач-устройства)
  function updateGate() {
    if (!state.isTouch || state.gateDismissed) { return; }
    var gate = document.getElementById('gate');
    if (!gate) { return; }
    var portrait = window.innerHeight > window.innerWidth;
    gate.className = portrait ? 'visible' : '';
  }

  // плавающее меню: круглые кнопки раскладок 1–5, прозрачный фон
  // меню раскладок: 1 змейка, 2 режим-2, 3 два столбца, 4 одно фото
  var MENU_LAYOUTS = ['snake', 'grid2x2', 'grid3x3', 'single'];
  var MENU_LABELS = ['1', '2', '3', '4'];

  function buildTouchMenu() {
    var menu = document.getElementById('tmenu');
    if (!menu || menu.childNodes.length) { return; }
    // компактные кнопки на низких экранах
    var vh = window.innerHeight || 720;
    var btn = Math.max(34, Math.min(54, Math.round(vh * 0.09)));
    for (var i = 0; i < MENU_LAYOUTS.length; i++) {
      (function (name, label) {
        var b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = label;
        b.style.width = btn + 'px';
        b.style.height = btn + 'px';
        b.style.margin = Math.round(btn * 0.16) + 'px 0';
        b.style.fontSize = Math.round(btn * 0.34) + 'px';
        b.style.lineHeight = btn + 'px';
        b.style.webkitBorderRadius = Math.round(btn / 2) + 'px';
        b.style.borderRadius = Math.round(btn / 2) + 'px';
        b.onclick = function (e) {
          if (e && e.stopPropagation) { e.stopPropagation(); }
          api.setLayout(name);
          markMenuActive();
        };
        b.setAttribute('data-layout', name);
        menu.appendChild(b);
      })(MENU_LAYOUTS[i], MENU_LABELS[i]);
    }
    markMenuActive();
    showTouchMenu();
    // на ТВ/десктопе меню живёт на правом поле постоянно; на таче
    // дополнительно: одиночный тап по фото показывает, тап по эскизу
    // и ход таймера прячут, двойной тап не перехватывается
  }

  function markMenuActive() {
    var menu = document.getElementById('tmenu');
    if (!menu) { return; }
    var btns = menu.getElementsByTagName('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].getAttribute('data-layout') === state.layoutName) {
        btns[i].className = 'active';
      } else {
        btns[i].className = '';
      }
    }
  }

  function showTouchMenu() {
    var menu = document.getElementById('tmenu');
    if (menu) { menu.className = 'visible'; }
  }

  // меню прячется после очередного хода таймера слайдшоу
  function hideTouchMenu() {
    var menu = document.getElementById('tmenu');
    if (menu) { menu.className = ''; }
  }

  /* ---------- компактный режим и обновления ----------
   * По первому тапу просим фуллскрин и лок альбомной ориентации
   * (Android WebView/Chrome; iOS Safari фуллскрин страниц не умеет —
   * там это PWA через «На главный экран»).
   * Раз в 5 минут (и при возврате на вкладку) сверяем version.js;
   * новая версия после деплоя -> тост с кнопкой «Обновить».
   */
  var appModeTried = false;
  function enterAppMode() {
    if (appModeTried) { return; }
    appModeTried = true;
    var el = document.documentElement;
    var rf = el.requestFullscreen || el.webkitRequestFullscreen ||
             el.mozRequestFullScreen || el.msRequestFullscreen;
    if (!rf) { return; }
    try {
      var res = rf.call(el);
      if (res && typeof res.then === 'function') {
        res.then(function () { lockLandscape(); }, function () {});
      } else {
        setTimeout(lockLandscape, 300);
      }
    } catch (e2) {}
  }
  function lockLandscape() {
    var so = window.screen && (window.screen.orientation || {});
    if (so && typeof so.lock === 'function') {
      try { so.lock('landscape').then(function(){}, function(){}); } catch (e) {}
    }
  }

  function initUpdateWatch() {
    if (typeof window.XMLHttpRequest === 'undefined' || !window.APP_VERSION) { return; }
    var btn = document.getElementById('updReload');
    if (btn) {
      btn.onclick = function () {
        try { window.location.reload(true); } catch (e) { window.location.reload(); }
      };
    }
    function check() {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', 'version.js?_=' + Date.now(), true);
      xhr.onreadystatechange = function () {
        if (xhr.readyState !== 4) { return; }
        var m = /APP_VERSION\s*=\s*'([^']+)'/.exec(xhr.responseText || '');
        if (m && m[1] !== window.APP_VERSION) {
          var toast = document.getElementById('updtoast');
          if (toast) { toast.className = 'visible'; }
        }
      };
      xhr.send(null);
    }
    setInterval(check, 5 * 60 * 1000);
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden) { check(); }
      }, false);
    }
  }

  // тапы: одиночный по области фото показывает меню, двойной
  // не перехватывается (системное поведение/зум); тапы по меню,
  // эскизам и панели статистики игнорируем
  function initTapMenu() {
    var tx = 0, ty = 0, tapTimerId = null;

    document.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) { tx = e.touches[0].clientX; ty = e.touches[0].clientY; }
    }, false);

    document.addEventListener('touchend', function (e) {
      if (!e.changedTouches.length) { return; }
      enterAppMode();
      var t = e.changedTouches[0];
      if (Math.abs(t.clientX - tx) > 10 || Math.abs(t.clientY - ty) > 10) { return; } // свайп

      // тап по меню/кнопкам/статистике — не наша забота
      var el = e.target;
      while (el && el !== document.body) {
        var cls = ' ' + (el.className || '') + ' ';
        if (el.id === 'tmenu' || cls.indexOf('navcell') !== -1 ||
            cls.indexOf('stats') !== -1 || el.tagName === 'BUTTON') { return; }
        el = el.parentElement || el.parentNode;
      }

      if (tapTimerId !== null) {
        // второй тап быстро за первым = двойной: отменяем показ меню,
        // ничего не перехватываем — работает системное поведение
        clearTimeout(tapTimerId);
        tapTimerId = null;
        return;
      }
      tapTimerId = setTimeout(function () {
        tapTimerId = null;
        showTouchMenu();
      }, 280);
    }, false);
  }

  // свайп: горизонтальный — страница вперёд/назад
  function initSwipe() {
    var sx = 0, sy = 0, st = 0;
    document.addEventListener('touchstart', function (e) {
      if (e.touches.length === 1) {
        sx = e.touches[0].clientX;
        sy = e.touches[0].clientY;
        st = Date.now();
      }
    }, false);
    document.addEventListener('touchend', function (e) {
      if (st === 0 || !e.changedTouches.length) { return; }
      var dx = e.changedTouches[0].clientX - sx;
      var dy = e.changedTouches[0].clientY - sy;
      var dur = Date.now() - st;
      st = 0;
      if (dur > 800) { return; }
      // считаем только выраженные горизонтальные свайпы
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) {
        if (!isSnake()) { return; }
        throttledPageAction(function () {
          state.lastDirection = dx < 0 ? 1 : -1;
          if (dx < 0) { api.nextPage(); } else { api.prevPage(); }
        });
      }
    }, false);
  }

  // действие пользователя: сбрасывает отсчёт таймера слайдшоу
  function resetCountdown() {
    if (isSnake()) { restartTimer(); }
  }

  // троттлинг действий-перелистываний: считаем последнее
  function throttledPageAction(fn) {
    var now = Date.now();
    if (now < state.throttleUntil) { return; }
    state.throttleUntil = now + 250;
    fn();
    resetCountdown();
  }

  function normalizePhotos() {
    for (var i = 0; i < state.photos.length; i++) {
      var p = state.photos[i];
      if (typeof p === 'string') {
        p = { name: p, mid: p, thumb: p, o: 'l', r: 1.5 };
      }
      if (typeof p.r !== 'number') { p.r = (p.o === 'p') ? 0.75 : 1.5; }
      state.photos[i] = p;
    }
  }

  function recalcPages() {
    state.portPool = [];
    state.landPool = [];
    for (var i = 0; i < state.photos.length; i++) {
      (state.photos[i].o === 'p' ? state.portPool : state.landPool).push(state.photos[i]);
    }
    state.landPool.sort(function (a, b) {
      return Math.abs((a.r || 1.5) - 1.333) - Math.abs((b.r || 1.5) - 1.333);
    });
    if (isSnake()) {
      state.pageCount = Math.max(1, state.portPool.length, state.landPool.length);
    } else if (isTape()) {
      state.pageCount = 1;
    } else {
      state.pageCount = Math.max(1, Math.ceil(state.photos.length / 7));
    }
  }

  /* ---------- прокрутка ленты: колесо + ленивый апгрейд ---------- */

  function initScroll() {
    var host = collageEl();

    var onWheel = function (e) {
      if (!isTape()) { return; }
      var d = e.wheelDelta ? e.wheelDelta : (-e.detail || 0) * 40;
      host.scrollTop -= d;
      scheduleUpgrade();
      if (e.preventDefault) { e.preventDefault(); }
      return false;
    };
    if (host.addEventListener) {
      host.addEventListener('mousewheel', onWheel, false);
      host.addEventListener('DOMMouseScroll', onWheel, false);
    }
    if (host.onscroll === null || typeof host.onscroll !== 'undefined') {
      host.onscroll = function () { scheduleUpgrade(); };
    }
  }

  function initResize() {
    var tId = null;
    // на мобилках resize при повороте приходит РАНЬШЕ смены
    // innerWidth/innerHeight — проверяем гейт несколько раз
    if (window.addEventListener) {
      window.addEventListener('orientationchange', function () {
        setTimeout(updateGate, 100);
        setTimeout(updateGate, 400);
      }, false);
    }
    window.onresize = function () {
      updateGate();
      setTimeout(updateGate, 300);
      if (tId !== null) { clearTimeout(tId); }
      tId = setTimeout(function () {
        // пересобираем ленту и змейку: размеры панелей считаются
        // от высоты экрана и должны пересчитаться
        if (isTape() || isSnake()) {
          var ratio = isTape() ? collageEl().scrollTop / Math.max(1, collageEl().scrollHeight) : 0;
          buildCells();
          if (isTape()) {
            collageEl().scrollTop = ratio * collageEl().scrollHeight;
            scheduleUpgrade();
          } else {
            renderPage();
          }
        }
      }, 300);
    };
  }

  /* ---------- пульт / клавиатура ----------
   * Лента (2/3/4): стрелки двигают курсор по ячейкам (экран
   * доскролливается), OK — открыть страницу «змейки» с этим фото,
   * Esc — режим свободной прокрутки (стрелки скроллят ленту,
   * OK возвращает курсор). Колесо мыши скроллит всегда.
   *
   * Змейка (1): фокус на ячейке/кнопке — стрелки двигают фокус,
   * OK нажимает; без фокуса стрелки листают страницы, OK — фокус
   * на первую ячейку. Esc — снять фокус. P/пробел — пауза,
   * 1–4 — раскладки, M — плейлист.
   */
  function initRemoteKeys() {
    var handler = function (e) {
      var key = (typeof e.key === 'string') ? e.key : '';
      var code = e.keyCode || e.which;
      var host = collageEl();

      var isRight = code === 39 || key === 'ArrowRight';
      var isLeft  = code === 37 || key === 'ArrowLeft';
      var isDown  = code === 40 || key === 'ArrowDown';
      var isUp    = code === 38 || key === 'ArrowUp';
      var isOK    = code === 13 || key === 'Enter';

      /* --- лента --- */
      if (isTape()) {
        var cellH = host.clientHeight / (LAYOUTS[state.layoutName].rowsPerScreen || 1);

        if (key === 'Escape' || code === 27 || key === 'GoBack' || code === 4) {
          if (state.isTouch) {
            showTouchMenu();  // Back — вернуть меню
          } else {
            state.freeScroll = !state.freeScroll; setCursor(state.cursorIdx, false);
          }
        } else if (state.isTouch && state.freeScroll) {
          if (isUp || isLeft)    { host.scrollTop -= cellH; scheduleUpgrade(); }
          else if (isDown || isRight) { host.scrollTop += cellH; scheduleUpgrade(); }
          else if (isOK)         { state.freeScroll = false; setCursor(state.cursorIdx); }
          else if (key === 'p' || key === 'P' || key === 'з' || key === 'З') { /* noop: в ленте нет автопоказа */ }
          else if (key === '1' || key === '2' || key === '3' || key === '4') {
            api.setLayout(['snake', 'grid2x2', 'grid3x3', 'single'][+key - 1]);
          } else if (key === 'm' || key === 'M' || key === 'ь' || key === 'Ь') { switchPlaylist(); }
          else { return; }
        } else {
          if (isLeft)       { moveCursor(-1, 0); }
          else if (isRight) { moveCursor(1, 0); }
          else if (isUp)    { moveCursor(0, -1); }
          else if (isDown)  { moveCursor(0, 1); }
          else if (isOK)    { activateCursor(); }
          else if (key === '1' || key === '2' || key === '3' || key === '4') {
            api.setLayout(['snake', 'grid2x2', 'grid3x3', 'single'][+key - 1]);
          } else if (key === 'm' || key === 'M' || key === 'ь' || key === 'Ь') { switchPlaylist(); }
          else { return; }
        }
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }

      /* --- змейка --- */
      if (key === 'Escape' || code === 27 || key === 'GoBack' || code === 4) {
        clearFocus();
        showTouchMenu();  // Back — вернуть меню
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }

      var focused = focusIdx() !== -1;
      if (focused) {
        if (isRight || isDown) {
          moveFocus(1);
        } else if (isLeft || isUp) {
          moveFocus(-1);
        } else if (isOK) {
          var el = document.activeElement;
          if (el && el.click) { el.click(); }
        } else if (key === '1' || key === '2' || key === '3' || key === '4') {
          api.setLayout(['snake', 'grid2x2', 'grid3x3', 'single'][+key - 1]);
        } else if (key === 'm' || key === 'M' || key === 'ь' || key === 'Ь') { switchPlaylist(); }
        else { return; }
        if (e.preventDefault) { e.preventDefault(); }
        return;
      }

      if (isRight || isDown) {
        throttledPageAction(function () {
          state.lastDirection = 1;
          api.nextPage();
        });
      } else if (isLeft || isUp) {
        throttledPageAction(function () {
          state.lastDirection = -1;
          api.prevPage();
        });
      } else if (isOK) {
        moveFocus(1);
      } else if (code === 32 || key === ' ' || key === 'p' || key === 'P' ||
                 key === 'з' || key === 'З') {
        if (state.paused) { api.resume(); } else { api.pause(); }
      } else if (key === '1' || key === '2' || key === '3' || key === '4') {
        api.setLayout(['snake', 'grid2x2', 'grid3x3', 'single'][+key - 1]);
      } else if (key === 'm' || key === 'M' || key === 'ь' || key === 'Ь') { switchPlaylist(); }
      else { return; }
      if (e.preventDefault) { e.preventDefault(); }
    };

    if (document.addEventListener) {
      document.addEventListener('keydown', handler, false);
    } else if (document.attachEvent) {
      document.attachEvent('onkeydown', function () { handler(window.event); });
    }
  }

  function switchPlaylist() {
    var cfg = (typeof COLLAGE_CONFIG !== 'undefined') ? COLLAGE_CONFIG : null;
    if (!cfg || !cfg.playlists) { return; }
    var names = [], name;
    for (name in cfg.playlists) {
      if (Object.prototype.hasOwnProperty.call(cfg.playlists, name)) { names.push(name); }
    }
    if (names.length < 2) { return; }
    var pos = names.indexOf(state.playlistName);
    api.setPlaylist(names[(pos + 1) % names.length]);
  }

  window.Collage = api;
})();
