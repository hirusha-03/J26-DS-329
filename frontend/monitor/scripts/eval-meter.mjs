// Measures the meter reader (src/lib/meterOcr.ts) on labelled meter photos.
//
// The photo dataset lives outside the repo (photos are large and stay local):
//   <dataset>/train/  photos used to calibrate the LCD layout
//   <dataset>/test/   held-back photos, only used to measure accuracy
//   <dataset>/labels.csv  file,ph,ec,temperature,temp_unit,humidity,light_bars,moisture_drops
//                         (file relative to <dataset>; empty cell = not labelled)
// <dataset> defaults to Vanilla-meter-dataset next to the repo; set METER_DATASET to use another folder.
//
// Usage: npm run eval:meter [-- train|test]
import { readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
const ts = require('typescript');
const sharp = require('sharp');

// Transpile the reader on the fly so this script always tests the current source.
const source = readFileSync(join(root, 'src/lib/meterOcr.ts'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const mod = { exports: {} };
new Function('module', 'exports', 'require', js)(mod, mod.exports, require);
const ocr = mod.exports;

const samples = process.env.METER_DATASET || join(root, '..', '..', '..', 'Vanilla-meter-dataset');
if (!existsSync(join(samples, 'labels.csv'))) {
  console.log(`No labels.csv in ${samples}. Set METER_DATASET to the meter photo dataset folder.`);
  process.exit(1);
}
const only = process.argv[2];
const rows = readFileSync(join(samples, 'labels.csv'), 'utf8').trim().split(/\r?\n/);
const header = rows.shift().split(',').map((h) => h.trim());
const labels = rows
  .map((line) => Object.fromEntries(line.split(',').map((v, i) => [header[i], v.trim()])))
  .filter((r) => r.file && (!only || r.file.startsWith(`${only}/`)));
if (!labels.length) {
  console.log(`No labelled photos found in ${samples}. Add photos to train/ or test/ and rows to labels.csv.`);
  process.exit(0);
}

const FIELDS = [
  ['ph', (a) => a.reading.fields.ph.value],
  ['ec', (a) => a.reading.fields.ec.value],
  ['temperature', (a) => a.reading.fields.temperature.value],
  ['humidity', (a) => a.reading.fields.humidity.value],
  ['light_bars', (a) => a.reading.lightBars],
  ['moisture_drops', (a) => a.reading.moistureDrops],
];
const stats = Object.fromEntries(FIELDS.map(([k]) => [k, { correct: 0, blank: 0, wrong: 0, total: 0 }]));
const outDir = join(samples, 'out');
let notFound = 0;

/** Draws boxes onto the corrected LCD and saves it as PNG for inspection. */
async function saveDebug(name, analysis) {
  const { width, height } = analysis.lcd;
  const px = Buffer.from(analysis.lcd.data);
  const box = (b, [r, g, bl]) => {
    for (let x = Math.max(0, b.x0); x <= Math.min(width - 1, b.x1); x++) {
      for (const y of [b.y0, b.y1]) if (y >= 0 && y < height) px.set([r, g, bl, 255], (y * width + x) * 4);
    }
    for (let y = Math.max(0, b.y0); y <= Math.min(height - 1, b.y1); y++) {
      for (const x of [b.x0, b.x1]) if (x >= 0 && x < width) px.set([r, g, bl, 255], (y * width + x) * 4);
    }
  };
  const f = analysis.reading.fields;
  for (const k of Object.keys(f)) f[k].digitBoxes.forEach((b) => box(b, f[k].value === null ? [239, 68, 68] : [37, 99, 235]));
  analysis.reading.lightBoxes.forEach((b) => box(b, [124, 58, 237]));
  analysis.reading.dropBoxes.forEach((b) => box(b, [8, 145, 178]));
  mkdirSync(outDir, { recursive: true });
  await sharp(px, { raw: { width, height, channels: 4 } }).resize(width * 2, height * 2, { kernel: 'nearest' }).png().toFile(join(outDir, `${name}.png`));
}

for (const label of labels) {
  const path = join(samples, label.file);
  if (!existsSync(path)) {
    console.log(`MISSING  ${label.file}`);
    continue;
  }
  const { data, info } = await sharp(path).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const analysis = ocr.analyzeMeterPhoto({ width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length) });
  const name = basename(label.file).replace(/\.[^.]+$/, '');
  if (!analysis) {
    notFound++;
    console.log(`NO LCD   ${label.file}`);
    continue;
  }
  const notes = [];
  for (const [key, get] of FIELDS) {
    if (label[key] === '' || label[key] === undefined) continue;
    const want = Number(label[key]);
    const got = get(analysis);
    stats[key].total++;
    if (got === null) {
      stats[key].blank++;
      notes.push(`${key}=blank (want ${want})`);
    } else if (Math.abs(got - want) < 1e-6) {
      stats[key].correct++;
    } else {
      stats[key].wrong++;
      notes.push(`${key}=${got} WRONG (want ${want})`);
    }
  }
  console.log(`${notes.length ? 'CHECK   ' : 'OK      '} ${label.file}${notes.length ? '  ' + notes.join(', ') : ''}`);
  if (notes.length) await saveDebug(name, analysis);
}

console.log(`\n${labels.length} photos, LCD not found in ${notFound}`);
for (const [key, s] of Object.entries(stats)) {
  if (!s.total) continue;
  console.log(`${key.padEnd(15)} correct ${s.correct}/${s.total}   blank ${s.blank}   wrong ${s.wrong}`);
}
if (existsSync(outDir)) console.log(`\nDebug images for photos with mistakes: ${outDir}`);
