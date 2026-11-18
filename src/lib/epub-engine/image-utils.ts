import { zlibSync } from 'fflate';
import { computeCrc32 } from './crc32';
import type { ImageDimensions } from './types';

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] ?? 0) << 8) | (bytes[offset + 1] ?? 0);
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) >>> 0) +
    (((bytes[offset + 1] ?? 0) << 16) >>> 0) +
    (((bytes[offset + 2] ?? 0) << 8) >>> 0) +
    (bytes[offset + 3] ?? 0)
  );
}

/**
 * Inspect PNG or JPEG byte headers without requiring browser image decoding.
 * Falls back to null if headers are unrecognized or corrupted.
 */
export function inspectImageDimensions(
  bytes: Uint8Array,
  mediaTypeHint?: string
): ImageDimensions | null {
  if (bytes.length < 24) return null;

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const ihdr =
      bytes[12] === 0x49 &&
      bytes[13] === 0x48 &&
      bytes[14] === 0x44 &&
      bytes[15] === 0x52;
    if (ihdr) {
      const width = readUint32BE(bytes, 16);
      const height = readUint32BE(bytes, 20);
      if (width > 0 && height > 0) {
        return { width, height, pixels: width * height };
      }
    }
  }

  // JPEG signature: FF D8
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 8 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (offset < bytes.length && bytes[offset] === 0xff) {
        offset += 1;
      }
      const marker = bytes[offset];
      offset += 1;
      if (marker === undefined) break;
      if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;

      if (offset + 2 > bytes.length) break;
      const segmentLength = readUint16BE(bytes, offset);
      if (segmentLength < 2) break;

      const isSof =
        (marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf);
      if (isSof && offset + 7 <= bytes.length) {
        const height = readUint16BE(bytes, offset + 3);
        const width = readUint16BE(bytes, offset + 5);
        if (width > 0 && height > 0) {
          return { width, height, pixels: width * height };
        }
      }
      offset += segmentLength;
    }
  }

  // GIF87a / GIF89a
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes.length >= 10
  ) {
    const width = (bytes[6] ?? 0) | ((bytes[7] ?? 0) << 8);
    const height = (bytes[8] ?? 0) | ((bytes[9] ?? 0) << 8);
    if (width > 0 && height > 0) {
      return { width, height, pixels: width * height };
    }
  }

  void mediaTypeHint;
  return null;
}

export function detectImageFormat(
  fileName: string,
  bytes: Uint8Array,
  mimeHint?: string
): 'png' | 'jpeg' | 'webp' | 'gif' | 'bmp' | 'svg' | 'unknown' {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return 'webp';
  }
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return 'gif';
  }
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return 'bmp';
  }

  const lower = fileName.toLowerCase();
  const mime = (mimeHint ?? '').toLowerCase();
  if (lower.endsWith('.svg') || mime === 'image/svg+xml') return 'svg';
  if (lower.endsWith('.png') || mime === 'image/png') return 'png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg') || mime === 'image/jpeg') return 'jpeg';
  if (lower.endsWith('.webp') || mime === 'image/webp') return 'webp';
  if (lower.endsWith('.gif') || mime === 'image/gif') return 'gif';
  if (lower.endsWith('.bmp') || mime === 'image/bmp') return 'bmp';
  return 'unknown';
}

/**
 * Convert a browser-decodable raster image (e.g. WebP, GIF, BMP) to PNG bytes using HTMLCanvasElement.
 * Returns null if running outside a browser canvas environment (e.g., Node/JSDOM without canvas).
 */
export async function convertImageBytesToPngInBrowser(
  bytes: Uint8Array,
  mimeType: string
): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined' || typeof URL === 'undefined') {
    return null;
  }
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Failed to decode image in browser'));
      el.src = objectUrl;
    });
    const width = img.naturalWidth || img.width;
    const height = img.naturalHeight || img.height;
    if (width <= 0 || height <= 0) return null;

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);

    const pngBlob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), 'image/png');
    });
    if (!pngBlob) return null;
    const buffer = await pngBlob.arrayBuffer();
    return {
      bytes: new Uint8Array(buffer),
      width,
      height,
    };
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function uint8ToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function imageToDataUri(bytes: Uint8Array, mediaType: 'image/jpeg' | 'image/png'): string {
  return `data:${mediaType};base64,${uint8ToBase64(bytes)}`;
}

function makePngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i += 1) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  const crcVal = computeCrc32(crcInput);
  view.setUint32(8 + data.length, crcVal >>> 0, false);
  return chunk;
}

/**
 * Pure TypeScript RGB PNG encoder (works in both Node/Vitest and Browser).
 * Used to create crisp, deterministic sample diagrams and fallback covers without external canvas libs.
 */
export function encodeSolidAndBandsPng(
  width: number,
  height: number,
  pixelPainter: (x: number, y: number, w: number, h: number) => [number, number, number]
): Uint8Array {
  const rowLength = 1 + width * 3;
  const raw = new Uint8Array(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * rowLength;
    raw[rowStart] = 0; // filter type 0
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixelPainter(x, y, width, height);
      const offset = rowStart + 1 + x * 3;
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
    }
  }

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB color type
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idatData = zlibSync(raw, { level: 6 });

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makePngChunk('IHDR', ihdr);
  const idatChunk = makePngChunk('IDAT', idatData);
  const iendChunk = makePngChunk('IEND', new Uint8Array(0));

  const out = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length
  );
  let cursor = 0;
  for (const part of [signature, ihdrChunk, idatChunk, iendChunk]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/**
 * Generates a clean typographic PNG cover image in browser via Canvas, or falls back to
 * pure-TS geometric PNG encoding in headless Node/test environments.
 */
export async function renderTypographicCoverPng(
  title: string,
  author: string
): Promise<Uint8Array> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent.toLowerCase() : '';
  const isBrowserCanvasEnv =
    typeof document !== 'undefined' &&
    typeof window !== 'undefined' &&
    !ua.includes('jsdom') &&
    !ua.includes('node.js');
  if (isBrowserCanvasEnv) {
    try {
      const width = 900;
      const height = 1350;
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        // Editorial slate + warm paper cover design
        ctx.fillStyle = '#14171F';
        ctx.fillRect(0, 0, width, height);

        // Subtle accent spine stripe
        ctx.fillStyle = '#0A84FF';
        ctx.fillRect(0, 0, 28, height);

        // Framed card inset
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.16)';
        ctx.lineWidth = 3;
        ctx.strokeRect(84, 84, width - 144, height - 168);

        // Top badge
        ctx.fillStyle = '#60A5FA';
        ctx.font = '600 24px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText('EPUB 3 EDITION', 124, 172);

        // Title wrap with adaptive font size so long titles fit cleanly without clipping
        ctx.fillStyle = '#F8FAFC';
        const cleanTitle = (title || 'Untitled Book').trim();
        const titleFontSize = cleanTitle.length > 42 ? 46 : cleanTitle.length > 26 ? 54 : 62;
        const lineHeight = Math.round(titleFontSize * 1.28);
        ctx.font = `700 ${titleFontSize}px Georgia, "Noto Serif SC", serif`;
        const words = cleanTitle.split(/\s+/);
        const lines: string[] = [];
        let current = '';
        for (const word of words) {
          const test = current ? `${current} ${word}` : word;
          if (ctx.measureText(test).width > width - 256 && current) {
            lines.push(current);
            current = word;
          } else {
            current = test;
          }
        }
        if (current) lines.push(current);
        lines.slice(0, 10).forEach((line, idx) => {
          ctx.fillText(line, 124, 310 + idx * lineHeight);
        });

        // Divider rule
        ctx.fillStyle = '#0A84FF';
        ctx.fillRect(124, height - 290, 120, 6);

        // Author
        ctx.fillStyle = '#CBD5E1';
        ctx.font = '500 34px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.fillText((author || 'Unknown Author').trim(), 124, height - 210);

        const blob = await new Promise<Blob | null>((resolve) =>
          canvas.toBlob((b) => resolve(b), 'image/png')
        );
        if (blob) {
          return new Uint8Array(await blob.arrayBuffer());
        }
      }
    } catch {
      // Fall through to pure TS encoder
    }
  }

  // Deterministic pure TS fallback cover (600x900)
  return encodeSolidAndBandsPng(600, 900, (x, y, w, h) => {
    if (x < 20) return [10, 132, 255]; // blue spine
    if (
      (x >= 56 && x <= w - 56 && (y === 56 || y === 57 || y === h - 56 || y === h - 57)) ||
      (y >= 56 && y <= h - 56 && (x === 56 || x === 57 || x === w - 56 || x === w - 57))
    ) {
      return [71, 85, 105];
    }
    if (y >= 220 && y <= 232 && x >= 90 && x <= 380) {
      return [248, 250, 252];
    }
    if (y >= 260 && y <= 270 && x >= 90 && x <= 300) {
      return [148, 163, 184];
    }
    if (y >= h - 180 && y <= h - 174 && x >= 90 && x <= 180) {
      return [10, 132, 255];
    }
    return [20, 23, 31];
  });
}
