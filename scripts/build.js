#!/usr/bin/env node
/* ============================================================
 * Сборка коллажа: photos-src/ -> photos_mid/ + photos_thumb/ + config.js
 *
 * Читает все .jpg/.jpeg/.png из photos-src/, делает уменьшенные
 * копии (полные ~1600px и миниатюры ~400px), определяет ориентацию
 * (o: 'p' — портрет, 'l' — альбомная) и отношение сторон (r = w/h)
 * и пишет config.js — карту, по которой страница собирает раскладки.
 *
 * Инкрементально: файлы, не менявшиеся с прошлой сборки, пропускаются.
 * Выход: node scripts/build.js
 * ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');
const Jimp = require('jimp');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'photos-src');
const MID_DIR = path.join(ROOT, 'photos_mid');
const TH_DIR = path.join(ROOT, 'photos_thumb');
const CONFIG = path.join(ROOT, 'config.js');
const VERSION = path.join(ROOT, 'version.js');

const MID_MAX = 1600;   // длинная сторона полной копии
const TH_MAX = 400;     // длинная сторона миниатюры
const QUALITY = 82;

function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch (e) { return 0; }
}

function newerThan(src, ...candidates) {
  const sm = mtime(src);
  return candidates.every((f) => fs.existsSync(f) && mtime(f) >= sm);
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error('Нет папки photos-src/ — положите туда фото и запустите снова.');
    process.exit(1);
  }
  fs.mkdirSync(MID_DIR, { recursive: true });
  fs.mkdirSync(TH_DIR, { recursive: true });

  const files = fs.readdirSync(SRC)
    .filter((f) => /\.(jpe?g|png)$/i.test(f))
    .sort();

  if (!files.length) {
    console.error('photos-src/ пуст — нет фото для сборки.');
    process.exit(1);
  }

  const entries = [];
  let done = 0, skipped = 0;

  for (const name of files) {
    const src = path.join(SRC, name);
    const midName = name.replace(/\.(jpe?g|png)$/i, '.jpg');
    const mid = path.join(MID_DIR, midName);
    const th = path.join(TH_DIR, midName);

    if (newerThan(src, mid, th)) {
      // уже собрано: размеры берём из готовой полной копии
      const img = await Jimp.read(mid);
      entries.push(entry(midName, img.bitmap.width, img.bitmap.height));
      skipped++;
      continue;
    }

    const img = await Jimp.read(src);
    const w = img.bitmap.width, h = img.bitmap.height;

    const midImg = img.clone().scaleToFit(MID_MAX, MID_MAX);
    midImg.quality(QUALITY);
    await midImg.writeAsync(mid);

    const thImg = img.clone().scaleToFit(TH_MAX, TH_MAX);
    thImg.quality(QUALITY);
    await thImg.writeAsync(th);

    entries.push(entry(midName, midImg.bitmap.width, midImg.bitmap.height));
    done++;
    process.stdout.write(`  + ${name}\n`);
  }

  fs.writeFileSync(CONFIG, renderConfig(entries), 'utf8');
  fs.writeFileSync(VERSION,
    "/* Версия приложения. Обновляется при каждой сборке; открытая " +
    "страница предложит перезагрузиться, увидев новую версию. */\n" +
    `window.APP_VERSION = '${stamp()}';\n`, 'utf8');

  console.log(`Готово: ${done} новых, ${skipped} без изменений, всего ${entries.length} фото.`);
  console.log('config.js и version.js записаны. Запуск показа: npm run serve');
}

function entry(midName, w, h) {
  return {
    name: midName,
    mid: `photos_mid/${midName}`,
    thumb: `photos_thumb/${midName}`,
    o: h > w ? 'p' : 'l',
    r: Math.round((w / h) * 1000) / 1000
  };
}

function renderConfig(entries) {
  const lines = entries.map((e) =>
    `      { name: '${e.name}', mid: '${e.mid}', thumb: '${e.thumb}', o: '${e.o}', r: ${e.r} }`);
  return `/* ============================================================
 * КОНФИГУРАЦИЯ КОЛЛАЖА — сгенерирована scripts/build.js.
 * Фото: photos_mid/ (~1600px) и photos_thumb/ (~400px).
 * o: 'p' — портретная ориентация, 'l' — альбомная. r = w/h.
 *
 * options можно поправить руками (файл перезапишется только
 * при следующем запуске npm run build).
 * ============================================================ */

var COLLAGE_CONFIG = {
  activePlaylist: 'main',

  playlists: {
    'main': [
${lines.join(',\n')}
    ]

    // Дополнительные наборы (переключение — клавиша M):
    // ,
    // 'second': [ ... те же строки для другого списка ... ]
  },

  options: {
    intervalSec: 10,      // пауза между страницами «змейки», сек
    fadeSec: 0.9,         // длительность переходов, сек
    scenario: null        // автосценарий раскладок, см. README
  }
};
`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

main().catch((e) => { console.error(e.message); process.exit(1); });
