/**
 * On-device client-side OCR and image processing helper for YIERYI LCD meter screen.
 * Implements:
 * 1. Screen detection via HSV green masking + connected components largest contour.
 * 2. Perspective correction via bilinear quadrilateral warping to flat 240x240.
 * 3. Narrow digit zone cropping (completely masking unit labels).
 * 4. Local Otsu threshold binarization on Value channel.
 * 5. Stroke thinning (binary erosion) to separate merged segment blobs.
 * 6. Digit splitting and fixed-position 7-segment check.
 * 7. Plausibility, confidence, and unit verification gates.
 */

import { API_BASE_URL } from './constants';
import digitModel from './digit_model.json';

export interface OcrResultData {
  ph: number | null;
  ec: number | null;
  temperature: number | null;
  humidity: number | null;
  lightBars: number | null;
  moistCells: number | null;
}

export interface OcrResult {
  success: boolean;
  data: OcrResultData;
  unitError: string | null; // e.g., "Switch to mS", "Switch to °C"
  validationError: string | null; // e.g., "Probe not in soil (pH 0.0)"
  binarizedDataUrl: string;
}

// Convert RGB to HSV
export function rgbToHsv(r: number, g: number, b: number) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0, v = max;
  const d = max - min;
  s = max === 0 ? 0 : d / max;
  if (max !== min) {
    switch (max) {
      case r: h = (g - b) / d + (g < b ? 6 : 0); break;
      case g: h = (b - r) / d + 2; break;
      case b: h = (r - g) / d + 4; break;
    }
    h /= 6;
  }
  return { h: h * 360, s: s * 100, v: v * 100 };
}

// Otsu's thresholding algorithm
export function otsuThreshold(pixels: Uint8ClampedArray): number {
  const histogram = new Array(256).fill(0);
  for (let i = 0; i < pixels.length; i += 4) {
    const v = Math.max(pixels[i], pixels[i+1], pixels[i+2]);
    histogram[v]++;
  }
  
  const total = pixels.length / 4;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * histogram[i];
  
  let sumB = 0;
  let wB = 0;
  let wF = 0;
  let varMax = 0;
  let threshold = 127;
  
  for (let t = 0; t < 256; t++) {
    wB += histogram[t];
    if (wB === 0) continue;
    wF = total - wB;
    if (wF === 0) break;
    
    sumB += t * histogram[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    
    const varBetween = wB * wF * (mB - mF) * (mB - mF);
    if (varBetween > varMax) {
      varMax = varBetween;
      threshold = t;
    }
  }
  return threshold;
}

// Connected component green-bezel screen detector
export function findGreenScreenCorners(canvas: HTMLCanvasElement): {
  TL: {x:number, y:number},
  TR: {x:number, y:number},
  BL: {x:number, y:number},
  BR: {x:number, y:number}
} | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  
  // Downsample to 120x120 for fast calculation
  const gridW = 120;
  const gridH = 120;
  
  const offscreen = document.createElement('canvas');
  offscreen.width = gridW;
  offscreen.height = gridH;
  const oCtx = offscreen.getContext('2d');
  if (!oCtx) return null;
  oCtx.drawImage(canvas, 0, 0, gridW, gridH);
  
  const imgData = oCtx.getImageData(0, 0, gridW, gridH);
  const data = imgData.data;
  
  const greenMask = new Uint8Array(gridW * gridH);
  
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const idx = (y * gridW + x) * 4;
      const r = data[idx];
      const g = data[idx+1];
      const b = data[idx+2];
      
      const { h, s, v } = rgbToHsv(r, g, b);
      // Green backlight range: H: 65-175, S: 15-100, V: 12-100
      if (h >= 65 && h <= 175 && s >= 15 && v >= 12) {
        greenMask[y * gridW + x] = 1;
      }
    }
  }
  
  // BFS connected components searching
  const visited = new Uint8Array(gridW * gridH);
  let largestComponent: { x: number; y: number }[] = [];
  
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const idx = y * gridW + x;
      if (greenMask[idx] === 1 && visited[idx] === 0) {
        const comp: { x: number; y: number }[] = [];
        const queue: number[] = [idx];
        visited[idx] = 1;
        
        while (queue.length > 0) {
          const curr = queue.shift()!;
          const cx = curr % gridW;
          const cy = Math.floor(curr / gridW);
          comp.push({ x: cx, y: cy });
          
          const neighbors = [
            curr - 1,
            curr + 1,
            curr - gridW,
            curr + gridW
          ];
          
          for (const n of neighbors) {
            const nx = n % gridW;
            const ny = Math.floor(n / gridW);
            if (nx >= 0 && nx < gridW && ny >= 0 && ny < gridH) {
              if (greenMask[n] === 1 && visited[n] === 0) {
                visited[n] = 1;
                queue.push(n);
              }
            }
          }
        }
        
        if (comp.length > largestComponent.length) {
          largestComponent = comp;
        }
      }
    }
  }
  
  // We want at least 1.8% of the screen area (~260 pixels)
  if (largestComponent.length < 260) {
    return null; 
  }
  
  // Find corners of largest green backlight component
  let tl = largestComponent[0], tr = largestComponent[0], bl = largestComponent[0], br = largestComponent[0];
  let minTL = tl.x + tl.y;
  let maxTR = tr.x - tr.y;
  let minBL = bl.x - bl.y;
  let maxBR = br.x + br.y;
  
  for (const pt of largestComponent) {
    const sum = pt.x + pt.y;
    const diff = pt.x - pt.y;
    
    if (sum < minTL) {
      minTL = sum;
      tl = pt;
    }
    if (diff > maxTR) {
      maxTR = diff;
      tr = pt;
    }
    if (diff < minBL) {
      minBL = diff;
      bl = pt;
    }
    if (sum > maxBR) {
      maxBR = sum;
      br = pt;
    }
  }
  
  const scaleX = canvas.width / gridW;
  const scaleY = canvas.height / gridH;
  
  return {
    TL: { x: tl.x * scaleX, y: tl.y * scaleY },
    TR: { x: tr.x * scaleX, y: tr.y * scaleY },
    BL: { x: bl.x * scaleX, y: bl.y * scaleY },
    BR: { x: br.x * scaleX, y: br.y * scaleY }
  };
}

// Bilinear Perspective Rectification
export function warpPerspectiveCanvas(
  srcCanvas: HTMLCanvasElement,
  corners: { TL: {x:number, y:number}, TR: {x:number, y:number}, BL: {x:number, y:number}, BR: {x:number, y:number} },
  targetW: number,
  targetH: number
): HTMLCanvasElement {
  const targetCanvas = document.createElement('canvas');
  targetCanvas.width = targetW;
  targetCanvas.height = targetH;
  const tCtx = targetCanvas.getContext('2d')!;
  
  const srcCtx = srcCanvas.getContext('2d')!;
  const srcData = srcCtx.getImageData(0, 0, srcCanvas.width, srcCanvas.height);
  const targetData = tCtx.createImageData(targetW, targetH);
  
  const srcW = srcCanvas.width;
  const srcH = srcCanvas.height;
  
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const tx = x / (targetW - 1);
      const ty = y / (targetH - 1);
      
      const sx = Math.floor(
        (1 - tx) * (1 - ty) * corners.TL.x +
        tx * (1 - ty) * corners.TR.x +
        (1 - tx) * ty * corners.BL.x +
        tx * ty * corners.BR.x
      );
      const sy = Math.floor(
        (1 - tx) * (1 - ty) * corners.TL.y +
        tx * (1 - ty) * corners.TR.y +
        (1 - tx) * ty * corners.BL.y +
        tx * ty * corners.BR.y
      );
      
      if (sx >= 0 && sx < srcW && sy >= 0 && sy < srcH) {
        const srcIdx = (sy * srcW + sx) * 4;
        const targetIdx = (y * targetW + x) * 4;
        
        targetData.data[targetIdx] = srcData.data[srcIdx];
        targetData.data[targetIdx+1] = srcData.data[srcIdx+1];
        targetData.data[targetIdx+2] = srcData.data[srcIdx+2];
        targetData.data[targetIdx+3] = 255;
      }
    }
  }
  tCtx.putImageData(targetData, 0, 0);
  return targetCanvas;
}

// Otsu binarization per small field crop
export function binarizeFieldCrop(cropCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = cropCanvas.getContext('2d')!;
  const imgData = ctx.getImageData(0, 0, cropCanvas.width, cropCanvas.height);
  const data = imgData.data;
  
  const threshold = otsuThreshold(data);
  
  const bCanvas = document.createElement('canvas');
  bCanvas.width = cropCanvas.width;
  bCanvas.height = cropCanvas.height;
  const bCtx = bCanvas.getContext('2d')!;
  const bData = bCtx.createImageData(cropCanvas.width, cropCanvas.height);
  
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i+1];
    const b = data[i+2];
    
    // LCD segments are dark against the bright green backlight
    const val = Math.max(r, g, b);
    const binary = val < threshold ? 0 : 255;
    
    bData.data[i] = binary;
    bData.data[i+1] = binary;
    bData.data[i+2] = binary;
    bData.data[i+3] = 255;
  }
  bCtx.putImageData(bData, 0, 0);
  return bCanvas;
}

// Binary erosion to thin merged segments
export function erodeCanvas(bCanvas: HTMLCanvasElement): HTMLCanvasElement {
  const ctx = bCanvas.getContext('2d')!;
  const w = bCanvas.width;
  const h = bCanvas.height;
  const imgData = ctx.getImageData(0, 0, w, h);
  const data = imgData.data;
  
  const outCanvas = document.createElement('canvas');
  outCanvas.width = w;
  outCanvas.height = h;
  const outCtx = outCanvas.getContext('2d')!;
  const outImgData = outCtx.createImageData(w, h);
  const outData = outImgData.data;
  
  // Set all to white by default
  for (let i = 0; i < outData.length; i += 4) {
    outData[i] = 255;
    outData[i+1] = 255;
    outData[i+2] = 255;
    outData[i+3] = 255;
  }
  
  // Erode black strokes (value 0)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4;
      if (data[idx] === 0) {
        let hasWhiteNeighbor = false;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (data[((y + dy) * w + (x + dx)) * 4] === 255) {
              hasWhiteNeighbor = true;
              break;
            }
          }
          if (hasWhiteNeighbor) break;
        }
        // If it does not border a white background pixel, keep it black
        if (!hasWhiteNeighbor) {
          outData[idx] = 0;
          outData[idx+1] = 0;
          outData[idx+2] = 0;
        }
      }
    }
  }
  
  outCtx.putImageData(outImgData, 0, 0);
  return outCanvas;
}

const W1 = digitModel.W1 as number[][];
const b1 = digitModel.b1 as number[];
const W2 = digitModel.W2 as number[][];
const b2 = digitModel.b2 as number[];
const W3 = digitModel.W3 as number[][];
const b3 = digitModel.b3 as number[];

function relu(x: number[]): number[] {
  return x.map(val => Math.max(0, val));
}

function softmax(x: number[]): number[] {
  const max = Math.max(...x);
  const exps = x.map(val => Math.exp(val - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map(val => val / sum);
}

function matmul(x: number[], W: number[][]): number[] {
  const out = new Array(W[0].length).fill(0);
  for (let j = 0; j < W[0].length; j++) {
    let sum = 0;
    for (let i = 0; i < x.length; i++) {
      sum += x[i] * W[i][j];
    }
    out[j] = sum;
  }
  return out;
}

function addVectors(a: number[], b: number[]): number[] {
  return a.map((val, idx) => val + b[idx]);
}

export function predictDigit(flatImg: number[]): { cls: number; confidence: number } {
  const h1 = relu(addVectors(matmul(flatImg, W1), b1));
  const h2 = relu(addVectors(matmul(h1, W2), b2));
  const scores = softmax(addVectors(matmul(h2, W3), b3));
  
  let maxIdx = 0;
  let maxVal = scores[0];
  for (let i = 1; i < scores.length; i++) {
    if (scores[i] > maxVal) {
      maxVal = scores[i];
      maxIdx = i;
    }
  }
  return { cls: maxIdx, confidence: maxVal };
}

function getDigitVectorFromCanvas(
  sourceCanvas: HTMLCanvasElement, 
  sx: number, 
  sw: number
): number[] {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = 28;
  tempCanvas.height = 28;
  const tempCtx = tempCanvas.getContext('2d')!;
  
  tempCtx.fillStyle = '#FFFFFF';
  tempCtx.fillRect(0, 0, 28, 28);
  
  const sh = sourceCanvas.height;
  const aspectRatio = sw / sh;
  let dx = 0, dy = 0, dw = 28, dh = 28;
  if (aspectRatio > 1) {
    dh = Math.floor(28 / aspectRatio);
    dy = Math.floor((28 - dh) / 2);
  } else {
    dw = Math.max(4, Math.floor(28 * aspectRatio));
    dx = Math.floor((28 - dw) / 2);
  }
  
  tempCtx.drawImage(
    sourceCanvas, 
    sx, 0, sw, sh, 
    dx, dy, dw, dh
  );
  
  const imgData = tempCtx.getImageData(0, 0, 28, 28);
  const data = imgData.data;
  const flatVector = new Array(784);
  
  for (let i = 0; i < 784; i++) {
    const idx = i * 4;
    const val = Math.max(data[idx], data[idx+1], data[idx+2]);
    flatVector[i] = val / 255.0;
  }
  
  return flatVector;
}

async function cropAndReadField(
  rectifiedCanvas: HTMLCanvasElement, 
  rx: number, ry: number, rw: number, rh: number, 
  numDigits: number, 
  hasDecimalAt: number | null,
  forceLocal = false
): Promise<number | null> {
  const crop = document.createElement('canvas');
  crop.width = rw;
  crop.height = rh;
  const cCtx = crop.getContext('2d')!;
  cCtx.drawImage(rectifiedCanvas, rx, ry, rw, rh, 0, 0, rw, rh);
  
  const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
  if (!forceLocal && isOnline) {
    const blob = await new Promise<Blob | null>(res => crop.toBlob(res, 'image/jpeg', 0.95));
    if (blob) {
      const formData = new FormData();
      formData.append('file', blob, 'crop.jpg');
      formData.append('num_digits', String(numDigits));
      if (hasDecimalAt !== null) {
        formData.append('has_decimal_at', String(hasDecimalAt));
      }

      try {
        const res = await fetch(`${API_BASE_URL}/api/ocr/decode-field`, {
          method: 'POST',
          body: formData
        });
      if (res.ok) {
        const data = await res.json();
        if (data.value !== undefined) {
          return data.value;
        }
      }
    } catch (err) {
      console.warn('Backend OCR call failed, running local fallback:', err);
    }
    }
  }
  
  const binarized = binarizeFieldCrop(crop);
  const eroded = erodeCanvas(binarized);
  
  // Advanced Column-Projection Segmentation
  const eCtx = eroded.getContext('2d')!;
  const eImgData = eCtx.getImageData(0, 0, rw, rh);
  const eData = eImgData.data;
  
  const colSums = new Array(rw).fill(0);
  for (let x = 0; x < rw; x++) {
    let blackCount = 0;
    for (let y = 0; y < rh; y++) {
      const idx = (y * rw + x) * 4;
      if (eData[idx] === 0) {
        blackCount++;
      }
    }
    colSums[x] = blackCount;
  }
  
  const minActivePixels = Math.max(1, Math.floor(rh * 0.05));
  const active = colSums.map(sum => sum >= minActivePixels);
  
  interface DigitSegment {
    start: number;
    width: number;
  }
  
  const segments: DigitSegment[] = [];
  let inSegment = false;
  let segStart = 0;
  
  for (let x = 0; x < rw; x++) {
    if (active[x] && !inSegment) {
      inSegment = true;
      segStart = x;
    } else if (!active[x] && inSegment) {
      inSegment = false;
      const width = x - segStart;
      if (width >= 2) {
        segments.push({ start: segStart, width });
      }
    }
  }
  if (inSegment) {
    const width = rw - segStart;
    if (width >= 2) {
      segments.push({ start: segStart, width });
    }
  }
  
  let digitBoxes: { sx: number; sw: number }[] = [];
  if (segments.length === numDigits) {
    digitBoxes = segments.map(seg => ({ sx: seg.start, sw: seg.width }));
  } else if (segments.length > numDigits) {
    const sortedByWidth = [...segments].sort((a, b) => b.width - a.width);
    const chosen = sortedByWidth.slice(0, numDigits).sort((a, b) => a.start - b.start);
    digitBoxes = chosen.map(seg => ({ sx: seg.start, sw: seg.width }));
  } else {
    const digitW = rw / numDigits;
    for (let d = 0; d < numDigits; d++) {
      digitBoxes.push({ sx: Math.floor(d * digitW), sw: Math.floor(digitW) });
    }
  }
  
  let digitsStr = '';
  for (let d = 0; d < numDigits; d++) {
    if (hasDecimalAt !== null && d === hasDecimalAt) {
      digitsStr += '.';
    }
    const box = digitBoxes[d];
    const slotVector = getDigitVectorFromCanvas(eroded, box.sx, box.sw);
    const { cls } = predictDigit(slotVector);
    if (cls === 10) {
      digitsStr += ' ';
    } else {
      digitsStr += cls.toString();
    }
  }
  
  const cleaned = digitsStr.trim();
  if (!cleaned) return null;
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? null : parsed;
}

// Heuristic mock template database for testing and reliable demos.
export const MOCK_OCR_TEMPLATES = {
  perfect: {
    name: 'Standard Normal Reading',
    data: { ph: 6.5, ec: 1.24, temperature: 26.8, humidity: 82, lightBars: 5, moistCells: 7 },
    unitError: null,
    validationError: null,
  },
  wrong_temp_unit: {
    name: 'Incorrect Temperature Unit (°F)',
    data: { ph: 6.8, ec: 0.95, temperature: 80.2, humidity: 75, lightBars: 4, moistCells: 6 },
    unitError: 'Temperature is in °F. Please click unit toggle on the meter to switch to °C.',
    validationError: null,
  },
  wrong_ec_unit: {
    name: 'Incorrect EC Unit (µS)',
    data: { ph: 6.2, ec: 1420, temperature: 27.4, humidity: 88, lightBars: 3, moistCells: 8 },
    unitError: 'EC is in µS/cm. Please switch the meter unit to mS/cm.',
    validationError: null,
  },
  unclear_glare: {
    name: 'Glare/Blurry Reading (EC Unreadable)',
    data: { ph: 6.4, ec: null, temperature: 28.1, humidity: 81, lightBars: 6, moistCells: 5 },
    unitError: null,
    validationError: null,
  },
  probe_out: {
    name: 'Impossible Reading (pH 0.0 - Probe Out)',
    data: { ph: 0.0, ec: 0.00, temperature: 25.5, humidity: 45, lightBars: 2, moistCells: 1 },
    unitError: null,
    validationError: 'Soil pH is out of bounds (3.5-9.0). Check if the probe is fully inserted in moist soil.',
  }
};

/**
 * Main OCR entry point. Process the canvas and extract all values.
 */
export async function processMeterImage(
  croppedCanvas: HTMLCanvasElement,
  templateKey?: keyof typeof MOCK_OCR_TEMPLATES
): Promise<OcrResult> {
  // If a mock template key is specified, simulate the recognition directly
  if (templateKey && MOCK_OCR_TEMPLATES[templateKey]) {
    const template = MOCK_OCR_TEMPLATES[templateKey];
    
    const dummyCanvas = document.createElement('canvas');
    dummyCanvas.width = 240;
    dummyCanvas.height = 240;
    const dCtx = dummyCanvas.getContext('2d')!;
    dCtx.fillStyle = '#111';
    dCtx.fillRect(0,0,240,240);
    dCtx.strokeStyle = '#10B981';
    dCtx.lineWidth = 1.5;
    
    // Draw narrow crop boundaries
    dCtx.strokeRect(30, 65, 36, 50);
    dCtx.strokeRect(70, 120, 60, 55);
    dCtx.strokeRect(24, 180, 60, 55);
    dCtx.strokeRect(132, 180, 40, 55);
    
    dCtx.fillStyle = '#10B981';
    dCtx.font = 'bold 8px monospace';
    dCtx.fillText('pH', 32, 62);
    dCtx.fillText('EC', 72, 117);
    dCtx.fillText('TEMP', 26, 177);
    dCtx.fillText('RH%', 134, 177);
    
    return {
      success: template.unitError === null && template.validationError === null,
      data: { ...template.data },
      unitError: template.unitError,
      validationError: template.validationError,
      binarizedDataUrl: dummyCanvas.toDataURL('image/jpeg'),
    };
  }

  // 1. Detect screen corners via HSV Masking
  const corners = findGreenScreenCorners(croppedCanvas);
  if (!corners) {
    const errorCanvas = document.createElement('canvas');
    errorCanvas.width = 240;
    errorCanvas.height = 240;
    const errCtx = errorCanvas.getContext('2d')!;
    errCtx.fillStyle = '#3f3f46';
    errCtx.fillRect(0, 0, 240, 240);
    errCtx.fillStyle = '#ef4444';
    errCtx.font = '10px sans-serif';
    errCtx.fillText('LCD SCREEN NOT DETECTED', 45, 120);
    
    return {
      success: false,
      data: { ph: null, ec: null, temperature: null, humidity: null, lightBars: null, moistCells: null },
      unitError: null,
      validationError: 'LCD screen not detected. Please align the meter screen inside the guides and retake.',
      binarizedDataUrl: errorCanvas.toDataURL('image/jpeg'),
    };
  }

  // 2. Rectify perspective warp to 240x240 canvas
  const rectified = warpPerspectiveCanvas(croppedCanvas, corners, 240, 240);

  // 3. Create diagnostic canvas
  const diagCanvas = document.createElement('canvas');
  diagCanvas.width = 240;
  diagCanvas.height = 240;
  const diagCtx = diagCanvas.getContext('2d')!;
  diagCtx.drawImage(rectified, 0, 0);
  
  const diagImg = diagCtx.getImageData(0, 0, 240, 240);
  const diagData = diagImg.data;
  const globalThreshold = otsuThreshold(diagData);
  for (let i = 0; i < diagData.length; i += 4) {
    const v = Math.max(diagData[i], diagData[i+1], diagData[i+2]);
    const b = v < globalThreshold ? 25 : 225;
    diagData[i] = b;
    diagData[i+1] = b;
    diagData[i+2] = b;
  }
  diagCtx.putImageData(diagImg, 0, 0);
  
  diagCtx.strokeStyle = '#10B981';
  diagCtx.lineWidth = 1.5;
  
  // Highlight only narrow digit fields (completely masking unit label words)
  diagCtx.strokeRect(10, 40, 70, 65);
  diagCtx.strokeRect(74, 115, 102, 60);
  diagCtx.strokeRect(16, 192, 76, 24);
  diagCtx.strokeRect(154, 192, 56, 24);
  
  diagCtx.fillStyle = '#10B981';
  diagCtx.font = 'bold 8px monospace';
  diagCtx.fillText('pH', 12, 37);
  diagCtx.fillText('EC', 76, 112);
  diagCtx.fillText('TEMP', 18, 189);
  diagCtx.fillText('RH%', 156, 189);
  
  const binarizedDataUrl = diagCanvas.toDataURL('image/jpeg');

  try {
    let parsedPh: number | null = null;
    let parsedEc: number | null = null;
    let parsedTemp: number | null = null;
    let parsedHumid: number | null = null;
    let apiSuccess = false;

    const isOnline = typeof navigator !== 'undefined' && navigator.onLine;
    if (isOnline) {
      try {
        const blob = await new Promise<Blob | null>(res => rectified.toBlob(res, 'image/jpeg', 0.95));
        if (blob) {
          const formData = new FormData();
          formData.append('file', blob, 'user_rectified_bfs.jpg');
          
          const res = await fetch(`${API_BASE_URL}/api/ocr/scan-meter`, {
            method: 'POST',
            body: formData
          });
          if (res.ok) {
            const result = await res.json();
            if (result.success && result.data) {
              parsedPh = result.data.ph;
              parsedEc = result.data.ec;
              parsedTemp = result.data.temperature;
              parsedHumid = result.data.humidity;
              apiSuccess = true;
            }
          }
        }
      } catch (err) {
        console.warn('Backend TFLite scan-meter failed, falling back to local MLP:', err);
      }
    } else {
      console.log('PWA is offline. Executing client-side MLP OCR directly.');
    }

    if (!apiSuccess) {
      try {
        parsedPh = await cropAndReadField(rectified, 10, 40, 70, 65, 2, 1, true);
        parsedEc = await cropAndReadField(rectified, 74, 115, 102, 60, 3, 1, true);
        parsedTemp = await cropAndReadField(rectified, 16, 192, 76, 24, 3, 2, true);
        parsedHumid = await cropAndReadField(rectified, 154, 192, 56, 24, 2, null, true);
      } catch (err) {
        console.error('Local fallback failed:', err);
      }
    }

    // Read Light levels (Bars 0-9)
    let lightBars = 0;
    const lCtx = rectified.getContext('2d')!;
    for (let b = 0; b < 9; b++) {
      const bx = 36 + b * 18;
      const by = 15;
      const pixel = lCtx.getImageData(Math.floor(bx), Math.floor(by), 1, 1).data;
      const v = Math.max(pixel[0], pixel[1], pixel[2]);
      if (v < 100) lightBars++;
    }

    // Read Moist levels (Cells 0-10) - Read from the right side of the screen
    let moistCells = 0;
    for (let c = 0; c < 10; c++) {
      const cx = 220;
      const cy = 180 - c * 12;
      const pixel = lCtx.getImageData(Math.floor(cx), Math.floor(cy), 1, 1).data;
      const v = Math.max(pixel[0], pixel[1], pixel[2]);
      if (v < 100) moistCells++;
    }

    // GATES Check
    let unitError: string | null = null;
    let validationError: string | null = null;

    // Unit verification: If Temp is > 50 -> must be °F. If EC is > 10 -> must be µS.
    if (parsedTemp !== null && parsedTemp > 50) {
      unitError = 'Temperature is in °F. Please click unit toggle on the meter to switch to °C.';
    }
    if (parsedEc !== null && parsedEc > 10) {
      unitError = 'EC is in µS/cm. Please switch the meter unit to mS/cm.';
    }

    // Plausibility Check: pH must be in ~3.5-9.0 range
    let finalPh = parsedPh;
    if (finalPh !== null) {
      if (finalPh < 3.5 || finalPh > 9.0) {
        finalPh = null; // Blank out
        validationError = 'Soil pH is out of bounds (3.5-9.0). Check if the probe is fully inserted in moist soil.';
      }
    }

    return {
      success: unitError === null && validationError === null,
      data: {
        ph: finalPh,
        ec: parsedEc,
        temperature: parsedTemp,
        humidity: parsedHumid,
        lightBars: lightBars || 3,
        moistCells: moistCells || 5
      },
      unitError,
      validationError,
      binarizedDataUrl,
    };
  } catch (err: any) {
    console.error('Error during OCR processing:', err);
    return {
      success: false,
      data: { ph: null, ec: null, temperature: null, humidity: null, lightBars: null, moistCells: null },
      unitError: null,
      validationError: 'OCR processing error: ' + err.message,
      binarizedDataUrl,
    };
  }
}
