/**
 * On-device reader for the YIERYI 6-in-1 soil meter LCD.
 *
 * Reads soil pH, EC (mS/cm), temperature, air humidity (RH %), the light bar graph and
 * the moisture drop gauge from a single photo, fully offline, with classical computer vision:
 *
 *   1. Locate the green backlit LCD: colour mask -> most screen-like connected region -> 4 corners.
 *   2. Undo perspective with a homography onto a fixed-size, upright LCD image (the always-lit
 *      light icon marks the top-left corner, so sideways photos work too).
 *   3. Measure how much darker each pixel is than the backlight around it, and threshold every
 *      area of the LCD relative to its own darkest strokes, so faint "ghost" (unlit) segments
 *      drop out while lit segments under uneven light stay.
 *   4. Decode every number from its seven-segment digits (segment on/off pattern -> digit) and
 *      check it against the meter's fixed layout: digit count, spacing, right alignment, contrast.
 *   5. Count lit light bars and moisture drops slot by slot on their fixed grids.
 *
 * Anything that cannot be read confidently is returned as null: values are never guessed.
 * The pure functions work on plain RGBA buffers, so the pipeline can be tested outside a browser.
 */

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface Point {
  x: number;
  y: number;
}

/** Inclusive pixel bounds. */
export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export type FieldKey = 'ph' | 'ec' | 'temperature' | 'humidity';

export interface FieldReading {
  value: number | null;
  /** Decoded text, e.g. "0.17"; "?" marks a digit that could not be decoded. */
  text: string;
  /** False when a segment was borderline: the reading is unique but worth a second look. */
  confident: boolean;
  digitBoxes: Box[];
}

export interface LcdReading {
  fields: Record<FieldKey, FieldReading>;
  lightBars: number | null;
  moistureDrops: number | null;
  lightBoxes: Box[];
  dropBoxes: Box[];
}

/** Where the pH and EC digit rows sit on a well-aligned LCD (pixels of the corrected LCD). */
const ANCHORS = {
  ph: { top: 63, bottom: 160, right: 101 },
  ec: { top: 179, bottom: 279, right: 217 },
};

export interface MeterAnalysis {
  /** Perspective-corrected LCD, LCD_WIDTH x LCD_HEIGHT. */
  lcd: RgbaImage;
  /** LCD corners in the input photo: top-left, top-right, bottom-right, bottom-left. */
  corners: Point[];
  reading: LcdReading;
}

// ─── LCD layout ──────────────────────────────────────────────────────────────
// Positions are fractions of the backlit LCD area (0..1). The search windows are
// deliberately generous: digits, bars and drops are located inside them by content.

export const LCD_WIDTH = 300;
export const LCD_HEIGHT = 380;

interface NormBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface FieldSpec {
  region: NormBox;
  /** Expected digit height as a fraction of LCD height (sanity check). */
  digitHeight: number;
  /** Width of a full (non-"1") digit relative to its height in the corrected LCD. */
  digitAspect: number;
  /** The meter always shows this many decimals for the field (pH 0.0, EC 0.00 mS, 25.3 °C, 63 %). */
  decimals: number;
  /** With this many digits and no visible decimal point the value is a whole number (EC in µS/cm). */
  wholeNumberDigits?: number;
  /** Numbers are right-aligned: x of the last digit's right edge (fraction of LCD width). */
  rightEdge: number;
  /** Fewest digits a real reading shows (pH "0.0" = 2, EC "0.00" = 3, soil temperature "25.3" = 3). */
  minDigits: number;
  /** Plausible range; anything outside is a misread (e.g. soil at 100+ degrees). */
  min: number;
  max: number;
}

const FIELDS: Record<FieldKey, FieldSpec> = {
  ph: {
    region: { x0: 0.0, y0: 0.14, x1: 0.36, y1: 0.47 },
    digitHeight: 0.255,
    digitAspect: 0.34,
    decimals: 1,
    rightEdge: 0.337,
    minDigits: 2,
    min: 0,
    max: 14,
  },
  ec: {
    region: { x0: 0.22, y0: 0.46, x1: 0.78, y1: 0.755 },
    digitHeight: 0.263,
    digitAspect: 0.36,
    decimals: 2,
    wholeNumberDigits: 4,
    rightEdge: 0.723,
    minDigits: 3,
    min: 0,
    max: 9999,
  },
  temperature: {
    region: { x0: 0.0, y0: 0.76, x1: 0.52, y1: 1.0 },
    digitHeight: 0.184,
    digitAspect: 0.44,
    decimals: 1,
    rightEdge: 0.407,
    minDigits: 3,
    min: -10,
    max: 99.9,
  },
  humidity: {
    // Ends just past the digits: the "RH" and "%" labels start right after the last digit.
    region: { x0: 0.58, y0: 0.76, x1: 0.893, y1: 1.0 },
    digitHeight: 0.184,
    digitAspect: 0.41,
    decimals: 0,
    rightEdge: 0.877,
    minDigits: 2,
    min: 0,
    max: 100,
  },
};

/** Light bar graph, between the light icon (left) and the battery icon (right). */
const LIGHT_REGION: NormBox = { x0: 0.16, y0: 0.0, x1: 0.83, y1: 0.17 };
/**
 * 9 light bars, lit left to right. Slot centres measured on real photos; sampled in the lower
 * part that every bar shares (fractions of LCD width / height).
 */
const LIGHT_BAR_SLOTS = { x: 0.272, pitch: 0.0672, count: 9, y: 0.099, halfW: 0.014, halfH: 0.014 };
/** Moisture drops: right of the pH digits, below the "MOIST" label, above the EC digits. */
const MOIST_REGION: NormBox = { x0: 0.52, y0: 0.245, x1: 1.0, y1: 0.46 };
/** Drop slots: two rows of five, lit left to right, top row first (sampled at each drop's filled base). */
const DROP_SLOTS = { x: 0.605, pitch: 0.0825, rows: [0.298, 0.389], halfW: 0.022, halfH: 0.02 };

// ─── 1. Find the backlit LCD ─────────────────────────────────────────────────

const DETECT_MAX_SIDE = 800;

/** Area-averaging downscale so that the longer side is at most maxSide. */
export function resizeArea(src: RgbaImage, maxSide: number): RgbaImage {
  const scale = Math.min(1, maxSide / Math.max(src.width, src.height));
  if (scale === 1) return src;
  const w = Math.max(1, Math.round(src.width * scale));
  const h = Math.max(1, Math.round(src.height * scale));
  const out = new Uint8ClampedArray(w * h * 4);
  const fx = src.width / w;
  const fy = src.height / h;
  for (let y = 0; y < h; y++) {
    const ya = Math.floor(y * fy);
    const yb = Math.max(ya + 1, Math.floor((y + 1) * fy));
    for (let x = 0; x < w; x++) {
      const xa = Math.floor(x * fx);
      const xb = Math.max(xa + 1, Math.floor((x + 1) * fx));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let yy = ya; yy < yb; yy++) {
        for (let xx = xa, i = (yy * src.width + xa) * 4; xx < xb; xx++, i += 4) {
          r += src.data[i];
          g += src.data[i + 1];
          b += src.data[i + 2];
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

/** Bright, saturated green-to-cyan pixels: the LCD backlight. */
function backlightMask(img: RgbaImage): Uint8Array {
  const { width, height, data } = img;
  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const d = max - Math.min(r, g, b);
    if (max < 110 || d < 0.28 * max) continue;
    let hue = max === r ? (60 * (g - b)) / d : max === g ? 120 + (60 * (b - r)) / d : 240 + (60 * (r - g)) / d;
    if (hue < 0) hue += 360;
    if (hue >= 70 && hue <= 175) mask[p] = 1;
  }
  return mask;
}

interface Component {
  label: number;
  area: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Connected components of a binary mask (4- or 8-connectivity). */
function labelComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  eight: boolean,
): { labels: Int32Array; comps: Component[] } {
  const labels = new Int32Array(w * h);
  const stack = new Int32Array(w * h);
  const comps: Component[] = [];
  let next = 1;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || labels[start]) continue;
    const c: Component = { label: next, area: 0, x0: w, y0: h, x1: -1, y1: -1 };
    let sp = 0;
    stack[sp++] = start;
    labels[start] = next;
    while (sp > 0) {
      const q = stack[--sp];
      const x = q % w;
      const y = (q - x) / w;
      c.area++;
      if (x < c.x0) c.x0 = x;
      if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y;
      if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if ((dx === 0 && dy === 0) || (!eight && dx !== 0 && dy !== 0)) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (mask[n] && !labels[n]) {
            labels[n] = next;
            stack[sp++] = n;
          }
        }
      }
    }
    comps.push(c);
    next++;
  }
  return { labels, comps };
}

function polygonArea(pts: Point[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Andrew's monotone chain convex hull. */
function convexHull(points: Point[]): Point[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/** Reduce a convex polygon to 4 vertices by repeatedly dropping the least significant vertex. */
function reduceToQuad(hull: Point[]): Point[] | null {
  const poly = [...hull];
  if (poly.length < 4) return null;
  while (poly.length > 4) {
    let minArea = Infinity;
    let minIdx = 0;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[(i - 1 + poly.length) % poly.length];
      const b = poly[i];
      const c = poly[(i + 1) % poly.length];
      const area = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y));
      if (area < minArea) {
        minArea = area;
        minIdx = i;
      }
    }
    poly.splice(minIdx, 1);
  }
  return poly;
}

/** Orders 4 corners clockwise starting from the top-left one. */
function orderCorners(quad: Point[]): Point[] {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const sorted = [...quad].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  let start = 0;
  for (let i = 1; i < 4; i++) if (sorted[i].x + sorted[i].y < sorted[start].x + sorted[start].y) start = i;
  return [0, 1, 2, 3].map((k) => sorted[(start + k) % 4]);
}

/** Total-least-squares line through points: returns a point on the line and its unit direction. */
function fitLine(pts: Point[]): { p: Point; d: Point } | null {
  if (pts.length < 6) return null;
  let mx = 0;
  let my = 0;
  for (const p of pts) {
    mx += p.x;
    my += p.y;
  }
  mx /= pts.length;
  my /= pts.length;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (const p of pts) {
    const dx = p.x - mx;
    const dy = p.y - my;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: { x: mx, y: my }, d: { x: Math.cos(angle), y: Math.sin(angle) } };
}

function intersect(a: { p: Point; d: Point }, b: { p: Point; d: Point }): Point | null {
  const det = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(det) < 1e-6) return null;
  const t = ((b.p.x - a.p.x) * b.d.y - (b.p.y - a.p.y) * b.d.x) / det;
  return { x: a.p.x + t * a.d.x, y: a.p.y + t * a.d.y };
}

/**
 * Finds the 4 corners of the backlit LCD (in the coordinates of `img`), ordered
 * top-left, top-right, bottom-right, bottom-left. Returns null when no screen is visible.
 */
export function findLcdQuad(img: RgbaImage): Point[] | null {
  const { width: w, height: h, data } = img;
  const mask = backlightMask(img);
  const { labels, comps } = labelComponents(mask, w, h, false);
  const minArea = 0.004 * w * h;
  const candidates = comps.filter((c) => c.area >= minArea).sort((a, b) => b.area - a.area).slice(0, 6);

  let best: { quad: Point[]; score: number } | null = null;
  for (const c of candidates) {
    const bw = c.x1 - c.x0 + 1;
    const bh = c.y1 - c.y0 + 1;
    // A region running off two edges is background (e.g. sunlit grass), not a screen in view.
    const edges = (c.x0 <= 0 ? 1 : 0) + (c.y0 <= 0 ? 1 : 0) + (c.x1 >= w - 1 ? 1 : 0) + (c.y1 >= h - 1 ? 1 : 0);
    if (edges >= 2) continue;

    // Row/column extents of the region (holes from dark digits don't change these).
    const rowMin = new Int32Array(bh).fill(-1);
    const rowMax = new Int32Array(bh).fill(-1);
    const colMin = new Int32Array(bw).fill(-1);
    const colMax = new Int32Array(bw).fill(-1);
    let vSum = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      for (let x = c.x0; x <= c.x1; x++) {
        if (labels[y * w + x] !== c.label) continue;
        const ry = y - c.y0;
        const rx = x - c.x0;
        if (rowMin[ry] < 0) rowMin[ry] = x;
        rowMax[ry] = x;
        if (colMin[rx] < 0 || y < colMin[rx]) colMin[rx] = y;
        if (y > colMax[rx]) colMax[rx] = y;
        const i = (y * w + x) * 4;
        vSum += Math.max(data[i], data[i + 1], data[i + 2]);
      }
    }

    const outline: Point[] = [];
    let filled = 0;
    for (let ry = 0; ry < bh; ry++) {
      if (rowMin[ry] < 0) continue;
      const y = c.y0 + ry;
      outline.push({ x: rowMin[ry], y }, { x: rowMin[ry], y: y + 1 }, { x: rowMax[ry] + 1, y }, { x: rowMax[ry] + 1, y: y + 1 });
      filled += rowMax[ry] - rowMin[ry] + 1;
    }
    const hull = convexHull(outline);
    const hullArea = polygonArea(hull);
    const quad = reduceToQuad(hull);
    if (!quad || hullArea <= 0) continue;

    const fill = filled / hullArea;
    const quadness = polygonArea(quad) / hullArea;
    const o = orderCorners(quad);
    const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
    const horiz = (side(o[0], o[1]) + side(o[3], o[2])) / 2;
    const vert = (side(o[0], o[3]) + side(o[1], o[2])) / 2;
    const aspect = Math.min(horiz, vert) / Math.max(horiz, vert);
    if (fill < 0.75 || quadness < 0.8 || aspect < 0.4) continue;

    const brightness = vSum / c.area / 255;
    if (brightness < 0.55) continue; // the backlight is one of the brightest things in the photo
    const score = filled * fill * fill * quadness * brightness * brightness * (aspect >= 0.55 ? 1 : 0.5);
    if (!best || score > best.score) best = { quad: o, score };

    // Refine each side by fitting a line to the region's boundary, ignoring the rounded corners.
    if (best.quad === o) {
      const boundary: Point[] = [];
      for (let ry = 0; ry < bh; ry++) {
        if (rowMin[ry] < 0) continue;
        boundary.push({ x: rowMin[ry], y: c.y0 + ry + 0.5 }, { x: rowMax[ry] + 1, y: c.y0 + ry + 0.5 });
      }
      for (let rx = 0; rx < bw; rx++) {
        if (colMin[rx] < 0) continue;
        boundary.push({ x: c.x0 + rx + 0.5, y: colMin[rx] }, { x: c.x0 + rx + 0.5, y: colMax[rx] + 1 });
      }
      const cx = o.reduce((sum, p) => sum + p.x, 0) / 4;
      const cy = o.reduce((sum, p) => sum + p.y, 0) / 4;
      const lines = o.map((a, i) => {
        const b = o[(i + 1) % 4];
        const len = side(a, b);
        const dx = (b.x - a.x) / len;
        const dy = (b.y - a.y) / len;
        const tol = Math.max(3, 0.08 * len);
        let pts = boundary.filter((p) => {
          const t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len;
          const dist = Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx);
          return t > 0.08 && t < 0.92 && dist <= tol;
        });
        // Icons near the edge (light icon, bars, battery) only ever pull the boundary inwards,
        // so refit on the outermost points.
        let line = fitLine(pts);
        for (let iter = 0; iter < 3 && line; iter++) {
          const l = line;
          let nx = -l.d.y;
          let ny = l.d.x;
          if ((l.p.x - cx) * nx + (l.p.y - cy) * ny < 0) {
            nx = -nx;
            ny = -ny;
          }
          const dist = pts.map((p) => (p.x - l.p.x) * nx + (p.y - l.p.y) * ny);
          const ref = [...dist].sort((u, v) => u - v)[Math.floor(0.7 * (dist.length - 1))];
          const kept = pts.filter((_, k) => dist[k] >= ref - 1.5);
          if (kept.length < 6) break;
          pts = kept;
          line = fitLine(pts);
        }
        return line;
      });
      if (lines.every((l) => l !== null)) {
        const refined = o.map((_, i) => intersect(lines[(i + 3) % 4]!, lines[i]!));
        const limit = 0.15 * Math.min(horiz, vert);
        if (refined.every((p, i) => p !== null && side(p, o[i]) <= limit)) best.quad = refined as Point[];
      }
    }
  }
  return best ? best.quad : null;
}

// ─── 2. Perspective correction ───────────────────────────────────────────────

/** Solves the 8 homography coefficients mapping src[i] -> dst[i]. */
function homography(src: Point[], dst: Point[]): number[] {
  const a: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  for (let col = 0; col < 8; col++) {
    let piv = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[piv][col])) piv = r;
    [a[col], a[piv]] = [a[piv], a[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      for (let k = col; k < 9; k++) a[r][k] -= f * a[col][k];
    }
  }
  return a.map((row, i) => row[8] / row[i]);
}

/** Maps a point of the corrected w x h LCD back into the photo. */
function lcdToPhoto(corners: Point[], w: number, h: number, u: number, v: number): Point {
  const hm = homography(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    corners,
  );
  const den = hm[6] * u + hm[7] * v + 1;
  return { x: (hm[0] * u + hm[1] * v + hm[2]) / den, y: (hm[3] * u + hm[4] * v + hm[5]) / den };
}

/** Warps the quadrilateral `corners` (TL, TR, BR, BL) of `src` onto an upright w x h image. */
export function warpQuad(src: RgbaImage, corners: Point[], w: number, h: number): RgbaImage {
  const hm = homography(
    [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h },
    ],
    corners,
  );
  const out = new Uint8ClampedArray(w * h * 4);
  const sw = src.width;
  const sh = src.height;
  const sd = src.data;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      const cu = u + 0.5;
      const cv = v + 0.5;
      const den = hm[6] * cu + hm[7] * cv + 1;
      const x = (hm[0] * cu + hm[1] * cv + hm[2]) / den - 0.5;
      const y = (hm[3] * cu + hm[4] * cv + hm[5]) / den - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(x)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(y)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = Math.max(0, Math.min(1, x - x0));
      const fy = Math.max(0, Math.min(1, y - y0));
      const o = (v * w + u) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const top = sd[(y0 * sw + x0) * 4 + ch] * (1 - fx) + sd[(y0 * sw + x1) * 4 + ch] * fx;
        const bot = sd[(y1 * sw + x0) * 4 + ch] * (1 - fx) + sd[(y1 * sw + x1) * 4 + ch] * fx;
        out[o + ch] = top * (1 - fy) + bot * fy;
      }
      out[o + 3] = 255;
    }
  }
  return { width: w, height: h, data: out };
}

// ─── 3. Binarise the LCD ─────────────────────────────────────────────────────

function luminance(img: RgbaImage): Float32Array {
  const lum = new Float32Array(img.width * img.height);
  for (let p = 0, i = 0; p < lum.length; p++, i += 4) {
    lum[p] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
  }
  return lum;
}

/**
 * How much darker each pixel is than the backlight around it (0 = backlight, 1 = black).
 * The backlight level is a blurred local maximum, so it isn't pulled down by the dark segments.
 */
function darknessMap(lcd: RgbaImage, lum: Float32Array): Float32Array {
  const { width: w, height: h } = lcd;
  const r = Math.max(3, Math.round(0.02 * w));
  const rowMax = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) m = Math.max(m, lum[y * w + k]);
      rowMax[y * w + x] = m;
    }
  }
  const integral = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) m = Math.max(m, rowMax[k * w + x]);
      rowSum += m;
      integral[(y + 1) * (w + 1) + x + 1] = integral[y * (w + 1) + x + 1] + rowSum;
    }
  }
  const b = Math.max(6, Math.round(0.05 * w));
  const dark = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ya = Math.max(0, y - b);
    const yb = Math.min(h, y + b + 1);
    for (let x = 0; x < w; x++) {
      const xa = Math.max(0, x - b);
      const xb = Math.min(w, x + b + 1);
      const sum =
        integral[yb * (w + 1) + xb] - integral[ya * (w + 1) + xb] - integral[yb * (w + 1) + xa] + integral[ya * (w + 1) + xa];
      const backlight = sum / ((yb - ya) * (xb - xa));
      dark[y * w + x] = backlight > 0 ? Math.max(0, 1 - lum[y * w + x] / backlight) : 0;
    }
  }
  return dark;
}

/**
 * 1 = lit LCD segment ("ink"). Each area (icon, bars, drops, every number) is thresholded at half
 * the darkness of its darkest strokes: lit segments clear that, the paler unlit ghosts don't.
 */
export function inkMask(lcd: RgbaImage, dark = darknessMap(lcd, luminance(lcd))): Uint8Array {
  const { width: w, height: h } = lcd;
  const mask = new Uint8Array(w * h);
  for (let p = 0; p < mask.length; p++) if (dark[p] > 0.15) mask[p] = 1;
  const regions = [LIGHT_ICON_REGION, LIGHT_REGION, MOIST_REGION, ...Object.values(FIELDS).map((f) => f.region)];
  for (const region of regions) {
    const box = toPx(region, w, h);
    const hist = new Uint32Array(256);
    let n = 0;
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) {
        hist[Math.min(255, Math.floor(dark[y * w + x] * 255))]++;
        n++;
      }
    }
    let seen = 0;
    let p99 = 0;
    for (let i = 255; i >= 0; i--) {
      seen += hist[i];
      if (seen >= 0.01 * n) {
        p99 = i / 255;
        break;
      }
    }
    const t = Math.max(0.08, 0.5 * p99);
    for (let y = box.y0; y <= box.y1; y++) {
      for (let x = box.x0; x <= box.x1; x++) mask[y * w + x] = dark[y * w + x] > t ? 1 : 0;
    }
  }
  // The LCD frame often shows as a dark line right at the edge: never part of a reading.
  const margin = Math.max(2, Math.round(0.012 * w));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < margin || x >= w - margin || y < margin || y >= h - margin) mask[y * w + x] = 0;
    }
  }
  return mask;
}

/**
 * 1 = glare: noticeably paler (less saturated) and at least as bright as the LCD's typical
 * backlight. Segments under glare can't be judged either way.
 */
function glareMask(lcd: RgbaImage, ink: Uint8Array): Uint8Array {
  const n = lcd.width * lcd.height;
  const sat = new Float32Array(n);
  const val = new Float32Array(n);
  const satBg: number[] = [];
  const valBg: number[] = [];
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const max = Math.max(lcd.data[i], lcd.data[i + 1], lcd.data[i + 2]);
    const min = Math.min(lcd.data[i], lcd.data[i + 1], lcd.data[i + 2]);
    sat[p] = max ? (max - min) / max : 0;
    val[p] = max;
    if (!ink[p] && p % 7 === 0) {
      satBg.push(sat[p]);
      valBg.push(max);
    }
  }
  const median = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const sMed = median(satBg);
  const vMed = median(valBg);
  const glare = new Uint8Array(n);
  for (let p = 0; p < n; p++) if (sat[p] < 0.6 * sMed && val[p] >= 0.9 * vMed) glare[p] = 1;
  return glare;
}

function fractionIn(map: Uint8Array, w: number, box: Box): number {
  let on = 0;
  let total = 0;
  for (let y = Math.max(0, box.y0); y <= box.y1; y++) {
    for (let x = Math.max(0, box.x0); x <= Math.min(w - 1, box.x1); x++) {
      on += map[y * w + x];
      total++;
    }
  }
  return total ? on / total : 0;
}

// ─── 4. Seven-segment numbers ────────────────────────────────────────────────

// Segment order a (top), b (top right), c (bottom right), d (bottom), e (bottom left), f (top left), g (middle).
const DIGIT_PATTERNS: [string, string][] = [
  ['1111110', '0'],
  ['0110000', '1'],
  ['1101101', '2'],
  ['1111001', '3'],
  ['0110011', '4'],
  ['1011011', '5'],
  ['1011111', '6'],
  ['0011111', '6'],
  ['1110000', '7'],
  ['1110010', '7'],
  ['1111111', '8'],
  ['1111011', '9'],
  ['1110011', '9'],
];

// A segment window's darkness relative to the field's lit segments: at least SEGMENT_ON = lit,
// at most SEGMENT_OFF = unlit, unsure in between. Measured on real photos: lit 0.5-1.1, unlit
// "ghost" segments 0.2-0.5 (this LCD's ghosts are clearly visible), empty windows near 0.
const SEGMENT_ON = 0.66;
const SEGMENT_OFF = 0.4;

// Sampling windows per segment, as fractions of the digit box: [x0, x1, y0, y1].
const SEGMENT_WINDOWS: [number, number, number, number][] = [
  [0.25, 0.75, 0.0, 0.2], // a
  [0.62, 1.0, 0.12, 0.45], // b
  [0.62, 1.0, 0.55, 0.88], // c
  [0.25, 0.75, 0.8, 1.0], // d
  [0.0, 0.38, 0.55, 0.88], // e
  [0.0, 0.38, 0.12, 0.45], // f
  [0.25, 0.75, 0.4, 0.6], // g
];

function toPx(r: NormBox, w: number, h: number): Box {
  return {
    x0: Math.max(0, Math.round(r.x0 * w)),
    y0: Math.max(0, Math.round(r.y0 * h)),
    x1: Math.min(w - 1, Math.round(r.x1 * w) - 1),
    y1: Math.min(h - 1, Math.round(r.y1 * h) - 1),
  };
}

/** Connected ink components inside `box` (8-connectivity), in full-image coordinates. */
function inkComponents(mask: Uint8Array, w: number, box: Box, minArea: number): Component[] {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  if (bw <= 0 || bh <= 0) return [];
  const sub = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) sub[y * bw + x] = mask[(box.y0 + y) * w + box.x0 + x];
  return labelComponents(sub, bw, bh, true)
    .comps.filter((c) => c.area >= minArea)
    .map((c) => ({ ...c, x0: c.x0 + box.x0, x1: c.x1 + box.x0, y0: c.y0 + box.y0, y1: c.y1 + box.y0 }));
}

/** Mean darkness of each of the 7 segment windows of a digit box (beyond the LCD counts as blank). */
function segmentLevels(dark: Float32Array, w: number, h: number, box: Box): number[] {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  return SEGMENT_WINDOWS.map(([fx0, fx1, fy0, fy1]) => {
    const xa = box.x0 + Math.floor(fx0 * bw);
    const xb = box.x0 + Math.max(Math.floor(fx0 * bw), Math.ceil(fx1 * bw) - 1);
    const ya = box.y0 + Math.floor(fy0 * bh);
    const yb = box.y0 + Math.max(Math.floor(fy0 * bh), Math.ceil(fy1 * bh) - 1);
    let sum = 0;
    let n = 0;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        if (x >= 0 && x < w && y >= 0 && y < h) sum += dark[y * w + x];
        n++;
      }
    }
    return n ? sum / n : 0;
  });
}

/**
 * Decodes one digit from its segment darkness levels. `lit` is how dark a lit segment is in this
 * field: a segment is on at >= SEGMENT_ON of that, off at <= SEGMENT_OFF (unlit "ghost" segments
 * are far paler), unsure in between. The digit is accepted only if exactly one digit agrees with
 * every on/off segment; otherwise "?" — a blurred or glared digit is left blank, never guessed.
 */
function decodeDigit(levels: number[], lit: number): { ch: string; unsure: boolean } {
  const states = levels.map((v) => (v >= SEGMENT_ON * lit ? '1' : v <= SEGMENT_OFF * lit ? '0' : '?'));
  const matches = new Set<string>();
  for (const [p, ch] of DIGIT_PATTERNS) {
    if (states.every((st, i) => st === '?' || st === p[i])) matches.add(ch);
  }
  if (matches.size !== 1) return { ch: '?', unsure: true };
  return { ch: [...matches][0], unsure: states.includes('?') };
}

/**
 * Rows of `box` that hold the field's digits. Runs of inked rows are joined across small gaps
 * (the break between a digit's upper and lower segments) as long as the result is no taller
 * than a digit; the run carrying the most ink wins.
 */
function digitBand(mask: Uint8Array, w: number, box: Box, expected: number): { y0: number; y1: number } | null {
  const rowMin = Math.max(2, Math.round(0.03 * (box.x1 - box.x0 + 1)));
  const runs: { y0: number; y1: number; mass: number }[] = [];
  for (let y = box.y0; y <= box.y1; y++) {
    let n = 0;
    for (let x = box.x0; x <= box.x1; x++) n += mask[y * w + x];
    if (n < rowMin) continue;
    const last = runs[runs.length - 1];
    if (last && last.y1 === y - 1) {
      last.y1 = y;
      last.mass += n;
    } else {
      runs.push({ y0: y, y1: y, mass: n });
    }
  }

  const gapTol = Math.max(2, Math.round(0.25 * expected));
  for (;;) {
    let pick = -1;
    let pickGap = Infinity;
    for (let i = 0; i + 1 < runs.length; i++) {
      const gap = runs[i + 1].y0 - runs[i].y1 - 1;
      if (gap <= gapTol && gap < pickGap && runs[i + 1].y1 - runs[i].y0 + 1 <= 1.12 * expected) {
        pick = i;
        pickGap = gap;
      }
    }
    if (pick < 0) break;
    const [a, b] = runs.splice(pick, 2);
    runs.splice(pick, 0, { y0: a.y0, y1: b.y1, mass: a.mass + b.mass });
  }

  let best: { y0: number; y1: number; mass: number } | null = null;
  for (const r of runs) {
    const rh = r.y1 - r.y0 + 1;
    if (rh >= 0.55 * expected && rh <= 1.3 * expected && (!best || r.mass > best.mass)) best = r;
  }
  return best;
}

function readField(
  mask: Uint8Array,
  lum: Float32Array,
  dark: Float32Array,
  glare: Uint8Array,
  w: number,
  h: number,
  spec: FieldSpec,
): FieldReading {
  const empty: FieldReading = { value: null, text: '', confident: false, digitBoxes: [] };
  const region = toPx(spec.region, w, h);
  const band = digitBand(mask, w, region, spec.digitHeight * h);
  if (!band) return empty;
  const hb = band.y1 - band.y0 + 1;

  const comps = inkComponents(mask, w, { x0: region.x0, x1: region.x1, y0: band.y0, y1: band.y1 }, Math.max(3, Math.round(0.002 * hb * hb)));
  // A decimal point is a small square on the baseline (a lone bottom segment is much wider).
  const isDot = (c: Component) => {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    return cw <= 0.13 * hb && ch <= 0.13 * hb && cw <= 1.8 * ch && ch <= 1.8 * cw && c.y1 >= band.y1 - 0.2 * hb;
  };
  const dots = comps.filter(isDot);

  // Group the segment shapes into cells by horizontal overlap.
  const cells: Box[] = [];
  for (const c of comps.filter((x) => !isDot(x)).sort((a, b) => a.x0 - b.x0)) {
    const cur = cells[cells.length - 1];
    if (cur && c.x0 <= cur.x1 + 1) {
      cur.x1 = Math.max(cur.x1, c.x1);
      cur.y0 = Math.min(cur.y0, c.y0);
      cur.y1 = Math.max(cur.y1, c.y1);
    } else {
      cells.push({ x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 });
    }
  }
  // Digits span (almost) the full band height; separate unit labels ("pH", "mS") are shorter, and
  // stacked labels such as "RH" over "%" leave a tall empty gap that no digit has.
  const largestGap = (c: Box) => {
    let gap = 0;
    let run = 0;
    for (let y = c.y0; y <= c.y1; y++) {
      let inked = false;
      for (let x = c.x0; x <= c.x1 && !inked; x++) inked = mask[y * w + x] === 1;
      run = inked ? 0 : run + 1;
      gap = Math.max(gap, run);
    }
    return gap;
  };
  const digitCells = cells.filter((c) => c.y1 - c.y0 + 1 >= 0.62 * hb && largestGap(c) <= 0.2 * hb);
  if (!digitCells.length) return empty;
  const inkIn = (x: number, y0: number, y1: number) => {
    for (let y = y0; y <= y1; y++) if (mask[y * w + x]) return true;
    return false;
  };

  let top = Math.min(...digitCells.map((c) => c.y0));
  let bottom = Math.max(...digitCells.map((c) => c.y1));
  const expectedH = spec.digitHeight * h;
  if (bottom - top + 1 < 0.95 * expectedH) {
    // No digit has a top bar (e.g. "41") or a bottom bar (e.g. "7.7"): restore the full digit height.
    // A top/bottom bar crosses the middle of the digit; side strokes don't.
    const barAt = (y0: number, y1: number) =>
      digitCells.some((c) => {
        const cw = c.x1 - c.x0 + 1;
        if (cw < 0.6 * spec.digitAspect * expectedH) return false;
        const xa = Math.round(c.x0 + 0.3 * cw);
        const xb = Math.round(c.x1 - 0.3 * cw);
        let inked = 0;
        for (let x = xa; x <= xb; x++) if (inkIn(x, y0, y1)) inked++;
        return inked >= 0.7 * (xb - xa + 1);
      });
    const span = Math.max(1, Math.round(0.08 * expectedH));
    const topBar = barAt(top, top + span);
    const bottomBar = barAt(bottom - span, bottom);
    if (topBar && !bottomBar) {
      bottom = Math.min(h - 1, Math.round(top + expectedH - 1));
    } else if (!topBar && bottomBar) {
      top = Math.max(0, Math.round(bottom - expectedH + 1));
    } else if (!topBar && !bottomBar) {
      const pad = Math.round((expectedH - (bottom - top + 1)) / 2);
      top = Math.max(0, top - pad);
      bottom = Math.min(h - 1, bottom + pad);
    }
  }
  if (bottom - top + 1 > 1.08 * expectedH) {
    // A frame or protective-film edge touching the digits stretches them downwards; the digit
    // tops are reliable, so keep the known digit height from the top.
    bottom = Math.min(h - 1, Math.round(top + expectedH - 1));
  }
  const dh = bottom - top + 1;
  const expectedW = spec.digitAspect * dh;
  const lowTop = Math.round(bottom - 0.25 * dh);
  const onlyLow = (x: number) => inkIn(x, lowTop, bottom) && !inkIn(x, top, lowTop - 1);

  // A decimal point touching a digit shows up as columns with ink only along the bottom edge.
  const pieces = digitCells.map((c) => {
    let { x0, x1 } = c;
    let dotAfter = false;
    let dotBefore = false;
    let k = x1;
    while (k > x0 && onlyLow(k)) k--;
    if (x1 - k >= 0.1 * expectedW && x1 - k <= 0.45 * expectedW) {
      x1 = k;
      dotAfter = true;
    }
    k = x0;
    while (k < x1 && onlyLow(k)) k++;
    if (k - x0 >= 0.1 * expectedW && k - x0 <= 0.45 * expectedW) {
      x0 = k;
      dotBefore = true;
    }
    return { x0, x1, dotAfter, dotBefore };
  });

  // A unit label touching the last digit ("mS", "%", "RH"): every digit's right side has ink
  // through the middle rows, a superscript or baseline label does not.
  const last = pieces[pieces.length - 1];
  if (last.x1 - last.x0 + 1 > 1.1 * expectedW) {
    const midTop = top + Math.round(0.42 * dh);
    const midBottom = top + Math.round(0.58 * dh);
    while (last.x1 - last.x0 + 1 > expectedW && !inkIn(last.x1, midTop, midBottom)) last.x1--;
  }

  // The widest single digit sets the width ("7" and "3" can be narrower than "8").
  const fullWidths = pieces.map((c) => c.x1 - c.x0 + 1).filter((cw) => cw >= 0.7 * expectedW && cw <= 1.3 * expectedW);
  const digitW = fullWidths.length
    ? Math.min(1.2 * expectedW, Math.max(0.9 * expectedW, ...fullWidths))
    : expectedW;
  const pitch = 1.33 * digitW;

  // Every digit is anchored on its right edge: all digits except "1" reach the right side of
  // their cell, and a "1" *is* that right-hand stroke.
  const slots: { x1: number; dotAfter: boolean; dotBefore: boolean }[] = [];
  for (const c of pieces) {
    const cw = c.x1 - c.x0 + 1;
    const n = Math.max(1, Math.round((cw + pitch - digitW) / pitch));
    if (n === 1) {
      if (cw < 0.12 * digitW) continue; // a hairline, not a digit stroke
      slots.push({ x1: c.x1, dotAfter: c.dotAfter, dotBefore: c.dotBefore });
      continue;
    }
    // neighbouring digits touched
    for (let k = 0; k < n; k++) {
      slots.push({
        x1: Math.round(c.x1 - (n - 1 - k) * pitch),
        dotAfter: k === n - 1 && c.dotAfter,
        dotBefore: k === 0 && c.dotBefore,
      });
    }
  }

  const boxOf = (x1: number): Box => ({ x0: Math.round(x1 - digitW + 1), x1, y0: top, y1: bottom });
  const levels = slots.map((sl) => segmentLevels(dark, w, h, boxOf(sl.x1)));
  const sortedLevels = levels.flat().sort((a, b) => a - b);
  const lit = sortedLevels[Math.floor(0.9 * (sortedLevels.length - 1))];
  if (lit < 0.05) return empty;
  // A position whose segments are all ghost-pale is empty: drop it from the front of the number
  // (e.g. the unlit "1" before "25.4"); inside the number it makes the reading unreliable.
  const blank = (lv: number[]) => Math.max(...lv) < 0.55 * lit;
  // A leading ghost "1" (the half-digit position) can be dark enough to pass, but stays clearly
  // weaker than the lit digits.
  const strongest = (lv: number[]) => Math.max(...lv);
  const weakLeader = () => {
    const rest = levels.slice(1).map(strongest).sort((a, b) => a - b);
    return (
      rest.length > 0 &&
      decodeDigit(levels[0], lit).ch === '1' &&
      strongest(levels[0]) < 0.75 * rest[Math.floor(rest.length / 2)]
    );
  };
  while (slots.length && (blank(levels[0]) || weakLeader())) {
    slots.shift();
    levels.shift();
  }
  if (!slots.length) return empty;
  const paleInside = levels.some(blank);

  let text = '';
  let confident = true;
  const boxes: Box[] = [];
  let dotSeen = slots.some((s, i) => (s.dotAfter && i + 1 < slots.length) || (s.dotBefore && i > 0));
  slots.forEach((slot, i) => {
    // May start left of the LCD for a leading "1" at its edge; that part counts as blank.
    boxes.push(boxOf(slot.x1));
    const { ch, unsure } = decodeDigit(levels[i], lit);
    if (unsure) confident = false;
    text += ch;
  });
  for (let i = 0; !dotSeen && i + 1 < boxes.length; i++) {
    const left = boxes[i];
    const right = boxes[i + 1];
    dotSeen = dots.some((d) => {
      const cx = (d.x0 + d.x1) / 2;
      return cx > left.x1 - 0.2 * digitW && cx < right.x0 + 0.35 * digitW;
    });
  }

  // The decimal position is fixed per field, so it doesn't depend on spotting the tiny dot.
  const decimals = spec.wholeNumberDigits && text.length >= spec.wholeNumberDigits && !dotSeen ? 0 : spec.decimals;
  if (decimals > 0 && text.length > decimals) text = text.slice(0, text.length - decimals) + '.' + text.slice(text.length - decimals);

  // The meter's fixed layout catches digits lost to blur or glare: enough digits, one digit pitch
  // apart, ending at the field's right edge, and clearly darker than the backlight.
  const lastEdge = slots[slots.length - 1].x1;
  const evenlySpaced = slots.every((sl, i) => i === 0 || (sl.x1 - slots[i - 1].x1 >= 0.6 * pitch && sl.x1 - slots[i - 1].x1 <= 1.45 * pitch));
  let inkSum = 0;
  let inkN = 0;
  let bgSum = 0;
  let bgN = 0;
  for (const b of boxes) {
    for (let y = b.y0; y <= b.y1; y++) {
      for (let x = Math.max(0, b.x0); x <= Math.min(w - 1, b.x1); x++) {
        if (mask[y * w + x]) {
          inkSum += lum[y * w + x];
          inkN++;
        } else {
          bgSum += lum[y * w + x];
          bgN++;
        }
      }
    }
  }
  const contrast = inkN && bgN ? 1 - inkSum / inkN / (bgSum / bgN) : 0;
  const glared = boxes.some((b) => fractionIn(glare, w, b) > 0.2);
  const layoutOk =
    slots.length >= spec.minDigits &&
    evenlySpaced &&
    Math.abs(lastEdge - spec.rightEdge * w) <= 0.5 * pitch &&
    contrast >= 0.15 &&
    !glared &&
    !paleInside;

  if (text.includes('?') || !layoutOk) return { value: null, text, confident: false, digitBoxes: boxes };
  const value = Number(text);
  if (!Number.isFinite(value) || value < spec.min || value > spec.max) {
    return { value: null, text, confident: false, digitBoxes: boxes };
  }
  return { value, text, confident, digitBoxes: boxes };
}

// ─── 5. Light bars and moisture drops ────────────────────────────────────────

function slotBox(cx: number, cy: number, halfW: number, halfH: number, w: number, h: number): Box {
  return {
    x0: Math.round((cx - halfW) * w),
    x1: Math.round((cx + halfW) * w),
    y0: Math.round((cy - halfH) * h),
    y1: Math.round((cy + halfH) * h),
  };
}

function meanIn(map: Float32Array, w: number, h: number, box: Box): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.max(0, box.y0); y <= Math.min(h - 1, box.y1); y++) {
    for (let x = Math.max(0, box.x0); x <= Math.min(w - 1, box.x1); x++) {
      sum += map[y * w + x];
      n++;
    }
  }
  return n ? sum / n : 0;
}

/**
 * Counts lit slots that fill a grid in order. A slot is lit when it is clearly darker than the
 * paler unlit ones; lit slots must come first and no slot may sit right at the threshold,
 * otherwise the count is unknown (null).
 */
function countLitSlots(values: number[], minLit: number, relative: number): number | null {
  const darkest = Math.max(0, ...values);
  const threshold = Math.max(minLit, relative * darkest);
  let count = 0;
  while (count < values.length && values[count] >= threshold) count++;
  // A slot right at the threshold could go either way: leave the count unknown rather than guess.
  if (count > 0 && values[count - 1] < 1.2 * threshold) return null;
  if (count < values.length && values[count] > 0.8 * threshold) return null;
  if (!count) return values.every((v) => v < 0.8 * threshold) ? 0 : null;
  const litMean = values.slice(0, count).reduce((a, b) => a + b, 0) / count;
  return values.slice(count).some((v) => v >= Math.max(threshold, 0.75 * litMean)) ? null : count;
}

function countLightBars(dark: Float32Array, w: number, h: number): { count: number | null; boxes: Box[] } {
  const g = LIGHT_BAR_SLOTS;
  const boxes = Array.from({ length: g.count }, (_, i) => slotBox(g.x + i * g.pitch, g.y, g.halfW, g.halfH, w, h));
  // Unlit bars are nearly invisible, so a low relative threshold keeps lit bars under uneven light.
  const count = countLitSlots(boxes.map((b) => meanIn(dark, w, h, b)), 0.07, 0.25);
  return { count, boxes: count ? boxes.slice(0, count) : [] };
}

function countMoistureDrops(dark: Float32Array, w: number, h: number): { count: number | null; boxes: Box[] } {
  const g = DROP_SLOTS;
  const boxes = g.rows.flatMap((ry) => Array.from({ length: 5 }, (_, i) => slotBox(g.x + i * g.pitch, ry, g.halfW, g.halfH, w, h)));
  // Unlit drops show as faint ghosts, so a lit drop must reach about half of the darkest one.
  const count = countLitSlots(boxes.map((b) => meanIn(dark, w, h, b)), 0.085, 0.5);
  return { count, boxes: count ? boxes.slice(0, count) : [] };
}

// ─── Whole-meter reading ─────────────────────────────────────────────────────

function readMask(lcd: RgbaImage, mask: Uint8Array, lum: Float32Array, dark: Float32Array): LcdReading {
  const { width: w, height: h } = lcd;
  const glare = glareMask(lcd, mask);
  const fields = {} as Record<FieldKey, FieldReading>;
  for (const key of Object.keys(FIELDS) as FieldKey[]) fields[key] = readField(mask, lum, dark, glare, w, h, FIELDS[key]);
  const light = countLightBars(dark, w, h);
  const drops = countMoistureDrops(dark, w, h);

  // Bars and drops are only trusted on a cleanly readable LCD: "0 bars" on a washed-out screen
  // is indistinguishable from bars that simply didn't show up.
  const numbersRead = (Object.values(fields) as FieldReading[]).filter((f) => f.value !== null).length;
  const healthy = numbersRead >= 2 && lightIconScore(mask, w, h) >= 0.5;
  const lightOk = healthy && fractionIn(glare, w, toPx(LIGHT_REGION, w, h)) <= 0.15;
  const dropsOk = healthy && fractionIn(glare, w, toPx(MOIST_REGION, w, h)) <= 0.15;
  return {
    fields,
    lightBars: lightOk ? light.count : null,
    moistureDrops: dropsOk ? drops.count : null,
    lightBoxes: light.boxes,
    dropBoxes: drops.boxes,
  };
}

/** Reads an already perspective-corrected, upright LCD image. */
export function readLcd(lcd: RgbaImage): LcdReading {
  const lum = luminance(lcd);
  const dark = darknessMap(lcd, lum);
  return readMask(lcd, inkMask(lcd, dark), lum, dark);
}

/** The always-lit light icon: a filled disc in the LCD's top-left corner. */
const LIGHT_ICON_REGION: NormBox = { x0: 0.0, y0: 0.0, x1: 0.24, y1: 0.16 };

/** Pixels of `box` enclosed by ink (ink plus its holes), as a share of the box. */
function filledShare(mask: Uint8Array, w: number, box: Box): number {
  const bw = box.x1 - box.x0 + 1;
  const bh = box.y1 - box.y0 + 1;
  const outside = new Uint8Array(bw * bh);
  const stack: number[] = [];
  const push = (x: number, y: number) => {
    const i = y * bw + x;
    if (!outside[i] && !mask[(box.y0 + y) * w + box.x0 + x]) {
      outside[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < bw; x++) {
    push(x, 0);
    push(x, bh - 1);
  }
  for (let y = 0; y < bh; y++) {
    push(0, y);
    push(bw - 1, y);
  }
  let reached = 0;
  while (stack.length) {
    const i = stack.pop()!;
    reached++;
    const x = i % bw;
    const y = (i - x) / bw;
    if (x > 0) push(x - 1, y);
    if (x < bw - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < bh - 1) push(x, y + 1);
  }
  return 1 - reached / (bw * bh);
}

/** 0..1: how much the top-left corner holds a round, filled disc of the light (sun) icon's size. */
function lightIconScore(mask: Uint8Array, w: number, h: number): number {
  let best = 0;
  for (const c of inkComponents(mask, w, toPx(LIGHT_ICON_REGION, w, h), 4)) {
    const cw = c.x1 - c.x0 + 1;
    const ch = c.y1 - c.y0 + 1;
    const d = (cw + ch) / 2;
    if (d < 0.05 * w || d > 0.16 * w) continue;
    const roundness = Math.min(cw, ch) / Math.max(cw, ch);
    const fill = filledShare(mask, w, c);
    if (roundness >= 0.6 && fill >= 0.5) best = Math.max(best, roundness * Math.min(1, fill / 0.78));
  }
  return best;
}

function readingScore(r: LcdReading): number {
  return (Object.values(r.fields) as FieldReading[]).reduce((s, f) => s + (f.value !== null ? (f.confident ? 10 : 6) : 0), 0);
}

/**
 * Full pipeline on a photo. Returns null when no backlit LCD is visible.
 * The photo may show the meter sideways or upside down: the light icon tells which corner is top-left.
 */
export function analyzeMeterPhoto(photo: RgbaImage): MeterAnalysis | null {
  const small = resizeArea(photo, DETECT_MAX_SIDE);
  const quad = findLcdQuad(small);
  if (!quad) return null;
  const sx = photo.width / small.width;
  const sy = photo.height / small.height;
  const corners = quad.map((p) => ({ x: p.x * sx, y: p.y * sy }));

  const views = [0, 1, 2, 3].map((rot) => {
    const rotated = [0, 1, 2, 3].map((k) => corners[(k + rot) % 4]);
    const lcd = warpQuad(photo, rotated, LCD_WIDTH, LCD_HEIGHT);
    const lum = luminance(lcd);
    const dark = darknessMap(lcd, lum);
    const mask = inkMask(lcd, dark);
    return { rotated, lcd, lum, dark, mask, icon: lightIconScore(mask, LCD_WIDTH, LCD_HEIGHT) };
  });
  views.sort((a, b) => b.icon - a.icon);

  let chosen = views[0];
  let reading = readMask(chosen.lcd, chosen.mask, chosen.lum, chosen.dark);
  if (chosen.icon < 0.5) {
    // Icon not visible (glare?): fall back to the orientation that decodes best.
    let bestScore = readingScore(reading);
    for (const v of views.slice(1)) {
      const r = readMask(v.lcd, v.mask, v.lum, v.dark);
      const score = readingScore(r);
      if (score > bestScore) {
        bestScore = score;
        chosen = v;
        reading = r;
      }
    }
    // Neither the light icon nor any number could be read: not a usable view of the meter.
    if (bestScore < 20) return null;
  }

  const realigned = realign(photo, chosen.rotated, reading);
  if (realigned && readingScore(realigned.reading) >= readingScore(reading)) return realigned;
  return { lcd: chosen.lcd, corners: chosen.rotated, reading };
}

/**
 * The detected screen outline can be slightly off (e.g. the clear protective film counted as
 * screen), which shifts the layout. The big pH and EC digit rows are found reliably, so compare
 * where they landed with where they belong, correct the corners and straighten the LCD again.
 */
function realign(photo: RgbaImage, corners: Point[], reading: LcdReading): MeterAnalysis | null {
  const ys: [number, number][] = [];
  const xs: [number, number][] = [];
  for (const key of ['ph', 'ec'] as const) {
    const boxes = reading.fields[key].digitBoxes;
    if (!boxes.length) continue;
    ys.push([ANCHORS[key].top, boxes[0].y0], [ANCHORS[key].bottom, boxes[0].y1]);
    xs.push([ANCHORS[key].right, boxes[boxes.length - 1].x1]);
  }
  if (ys.length < 2) return null;
  // Least-squares observed = scale * expected + offset.
  const fit = (pts: [number, number][]) => {
    const n = pts.length;
    const mx = pts.reduce((a, [x]) => a + x, 0) / n;
    const my = pts.reduce((a, [, y]) => a + y, 0) / n;
    const sxx = pts.reduce((a, [x]) => a + (x - mx) ** 2, 0);
    const scale = sxx > 0 ? pts.reduce((a, [x, y]) => a + (x - mx) * (y - my), 0) / sxx : 1;
    return { scale, offset: my - scale * mx };
  };
  const fy = fit(ys);
  const fx = xs.length >= 2 ? fit(xs) : { scale: 1, offset: xs[0][1] - xs[0][0] };
  const plausible = (f: { scale: number }) => f.scale > 0.8 && f.scale < 1.25;
  if (!plausible(fy) || !plausible(fx)) return null;
  const off =
    Math.abs(fy.scale - 1) * LCD_HEIGHT + Math.abs(fy.offset) + Math.abs(fx.scale - 1) * LCD_WIDTH + Math.abs(fx.offset);
  if (off < 4) return null; // already aligned

  const map = (u: number, v: number) =>
    lcdToPhoto(corners, LCD_WIDTH, LCD_HEIGHT, fx.scale * u + fx.offset, fy.scale * v + fy.offset);
  const fixed = [map(0, 0), map(LCD_WIDTH, 0), map(LCD_WIDTH, LCD_HEIGHT), map(0, LCD_HEIGHT)];
  const lcd = warpQuad(photo, fixed, LCD_WIDTH, LCD_HEIGHT);
  const lum = luminance(lcd);
  const dark = darknessMap(lcd, lum);
  return { lcd, corners: fixed, reading: readMask(lcd, inkMask(lcd, dark), lum, dark) };
}

// ─── Units ───────────────────────────────────────────────────────────────────

export type TemperatureUnit = 'C' | 'F';
export type EcUnit = 'mS' | 'uS';

/**
 * The meter can be switched to °F and µS/cm. Soil readings above 50 °C or 10 mS/cm are not
 * physically plausible here, so such values reveal the unit the meter is set to.
 */
export function inferUnits(reading: LcdReading): { temperature: TemperatureUnit | null; ec: EcUnit | null } {
  const t = reading.fields.temperature.value;
  const ec = reading.fields.ec;
  return {
    temperature: t === null ? null : t > 50 ? 'F' : 'C',
    ec: ec.value === null ? null : ec.value > 10 && !ec.text.includes('.') ? 'uS' : 'mS',
  };
}

// ─── Browser entry point ─────────────────────────────────────────────────────

export interface MeterScanResult {
  found: boolean;
  /** Guidance for the user when the LCD could not be found. */
  message: string | null;
  values: {
    ph: number | null;
    ec: number | null;
    temperature: number | null;
    humidity: number | null;
    lightBars: number | null;
    moistureDrops: number | null;
  };
  /** Per-field: false when a segment was borderline, so the value deserves a second look. */
  confident: Record<FieldKey, boolean>;
  units: { temperature: TemperatureUnit | null; ec: EcUnit | null };
  /** Perspective-corrected LCD with everything that was detected drawn on top. */
  overlayDataUrl: string | null;
}

const WORK_MAX_SIDE = 1600;

/** Decodes the photo upright (EXIF orientation applied) into RGBA, longer side at most WORK_MAX_SIDE. */
async function fileToRgba(file: Blob): Promise<RgbaImage> {
  let source: ImageBitmap | HTMLImageElement;
  try {
    source = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // Older Safari: fall back to an <img>, which also honours EXIF orientation.
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      source = img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const sw = source instanceof HTMLImageElement ? source.naturalWidth : source.width;
  const sh = source instanceof HTMLImageElement ? source.naturalHeight : source.height;
  const scale = Math.min(1, WORK_MAX_SIDE / Math.max(sw, sh));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (!(source instanceof HTMLImageElement)) source.close();
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { width: img.width, height: img.height, data: img.data };
}

const FIELD_LABELS: Record<FieldKey, string> = { ph: 'pH', ec: 'EC', temperature: 'TEMP', humidity: 'RH' };

function renderOverlay(analysis: MeterAnalysis): string {
  const { lcd, reading } = analysis;
  const scale = 2;
  const canvas = document.createElement('canvas');
  canvas.width = lcd.width * scale;
  canvas.height = lcd.height * scale;
  const ctx = canvas.getContext('2d')!;
  const base = document.createElement('canvas');
  base.width = lcd.width;
  base.height = lcd.height;
  base.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(lcd.data), lcd.width, lcd.height), 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base, 0, 0, canvas.width, canvas.height);

  const rect = (b: Box, colour: string) => {
    ctx.strokeStyle = colour;
    ctx.lineWidth = 2;
    ctx.strokeRect(b.x0 * scale - 1, b.y0 * scale - 1, (b.x1 - b.x0 + 1) * scale + 2, (b.y1 - b.y0 + 1) * scale + 2);
  };
  const label = (text: string, x: number, y: number, colour: string) => {
    ctx.font = 'bold 18px sans-serif';
    const tw = ctx.measureText(text).width;
    ctx.fillStyle = 'rgba(0,0,0,0.75)';
    ctx.fillRect(x - 2, y - 17, tw + 6, 21);
    ctx.fillStyle = colour;
    ctx.fillText(text, x + 1, y);
  };

  for (const key of Object.keys(reading.fields) as FieldKey[]) {
    const f = reading.fields[key];
    const colour = f.value === null ? '#ef4444' : f.confident ? '#2563eb' : '#f59e0b';
    f.digitBoxes.forEach((b) => rect(b, colour));
    if (f.digitBoxes.length) {
      const b = f.digitBoxes[0];
      label(`${FIELD_LABELS[key]} ${f.value === null ? '?' : f.text}`, b.x0 * scale, Math.max(18, b.y0 * scale - 4), colour);
    }
  }
  reading.lightBoxes.forEach((b) => rect(b, '#7c3aed'));
  reading.dropBoxes.forEach((b) => rect(b, '#0891b2'));
  if (reading.lightBoxes.length) {
    const b = reading.lightBoxes[reading.lightBoxes.length - 1];
    label(`${reading.lightBars ?? '?'} bars`, b.x1 * scale + 6, Math.max(18, (b.y1 + 1) * scale), '#7c3aed');
  }
  if (reading.dropBoxes.length) {
    const b = reading.dropBoxes[reading.dropBoxes.length - 1];
    label(`${reading.moistureDrops ?? '?'} drops`, Math.min(b.x0 * scale, canvas.width - 110), (b.y1 + 1) * scale + 20, '#0891b2');
  }
  return canvas.toDataURL('image/jpeg', 0.9);
}

/** Reads the meter from a photo file (camera capture or gallery image). */
export async function scanMeterPhoto(file: Blob): Promise<MeterScanResult> {
  const photo = await fileToRgba(file);
  const analysis = analyzeMeterPhoto(photo);
  if (!analysis) {
    return {
      found: false,
      message:
        'Could not read the meter screen. Turn the backlight on, keep the whole green screen in the frame and in focus, avoid glare, then retake.',
      values: { ph: null, ec: null, temperature: null, humidity: null, lightBars: null, moistureDrops: null },
      confident: { ph: false, ec: false, temperature: false, humidity: false },
      units: { temperature: null, ec: null },
      overlayDataUrl: null,
    };
  }
  const { fields, lightBars, moistureDrops } = analysis.reading;
  return {
    found: true,
    message: null,
    values: {
      ph: fields.ph.value,
      ec: fields.ec.value,
      temperature: fields.temperature.value,
      humidity: fields.humidity.value,
      lightBars,
      moistureDrops,
    },
    confident: {
      ph: fields.ph.confident,
      ec: fields.ec.confident,
      temperature: fields.temperature.confident,
      humidity: fields.humidity.confident,
    },
    units: inferUnits(analysis.reading),
    overlayDataUrl: renderOverlay(analysis),
  };
}
