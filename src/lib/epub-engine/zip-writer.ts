import { deflateSync } from 'fflate';
import { computeCrc32 } from './crc32';

export interface ZipEntryInput {
  path: string;
  data: Uint8Array;
  storeOnly?: boolean;
}

const textEncoder = new TextEncoder();

function encodeDosTimeAndDate(date: Date): { dosTime: number; dosDate: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const seconds = Math.floor(date.getUTCSeconds() / 2);

  const dosTime = (hours << 11) | (minutes << 5) | seconds;
  const dosDate = ((year - 1980) << 9) | (month << 5) | day;
  return { dosTime, dosDate };
}

/**
 * Builds a strict OCF/EPUB-compliant ZIP archive:
 * - Entry 0 MUST be `mimetype` stored uncompressed (method=0) with extraFieldLength=0.
 *   (Satisfies EPUBCheck PKG-005 / PKG-006 / OCF 3.3 requirements)
 * - Uses UTF-8 filename flag (bit 11 = 0x0800) so non-Latin names work everywhere.
 */
export function buildEpubZip(entries: ZipEntryInput[], modifiedDate = new Date()): Uint8Array {
  if (entries.length === 0 || entries[0]?.path !== 'mimetype') {
    throw new Error('EPUB ZIP requires "mimetype" as the exact first entry.');
  }

  const { dosTime, dosDate } = encodeDosTimeAndDate(modifiedDate);
  const localChunks: Uint8Array[] = [];
  const centralChunks: Uint8Array[] = [];
  let offset = 0;

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const nameBytes = textEncoder.encode(entry.path);
    const uncompressed = entry.data;
    const crc = computeCrc32(uncompressed);

    // mimetype MUST always be stored uncompressed; binary images also don't benefit from deflate
    const shouldStore = i === 0 || entry.storeOnly === true;
    let compressed: Uint8Array;
    let method: number;

    if (shouldStore) {
      compressed = uncompressed;
      method = 0;
    } else {
      const deflated = deflateSync(uncompressed, { level: 6 });
      if (deflated.length < uncompressed.length) {
        compressed = deflated;
        method = 8;
      } else {
        compressed = uncompressed;
        method = 0;
      }
    }

    const flags = 0x0800; // UTF-8 filename encoding

    // Local File Header (30 bytes + nameBytes.length, extraFieldLength = 0)
    const lfh = new Uint8Array(30 + nameBytes.length);
    const lfhView = new DataView(lfh.buffer);
    lfhView.setUint32(0, 0x04034b50, true); // signature
    lfhView.setUint16(4, 20, true); // version needed (2.0)
    lfhView.setUint16(6, flags, true);
    lfhView.setUint16(8, method, true);
    lfhView.setUint16(10, dosTime, true);
    lfhView.setUint16(12, dosDate, true);
    lfhView.setUint32(14, crc, true);
    lfhView.setUint32(18, compressed.length, true);
    lfhView.setUint32(22, uncompressed.length, true);
    lfhView.setUint16(26, nameBytes.length, true);
    lfhView.setUint16(28, 0, true); // extra field length MUST be 0 (vital for mimetype)
    lfh.set(nameBytes, 30);

    localChunks.push(lfh, compressed);

    // Central Directory File Header (46 bytes + nameBytes.length)
    const cdfh = new Uint8Array(46 + nameBytes.length);
    const cdfhView = new DataView(cdfh.buffer);
    cdfhView.setUint32(0, 0x02014b50, true); // signature
    cdfhView.setUint16(4, 20, true); // version made by
    cdfhView.setUint16(6, 20, true); // version needed
    cdfhView.setUint16(8, flags, true);
    cdfhView.setUint16(10, method, true);
    cdfhView.setUint16(12, dosTime, true);
    cdfhView.setUint16(14, dosDate, true);
    cdfhView.setUint32(16, crc, true);
    cdfhView.setUint32(20, compressed.length, true);
    cdfhView.setUint32(24, uncompressed.length, true);
    cdfhView.setUint16(28, nameBytes.length, true);
    cdfhView.setUint16(30, 0, true); // extra length
    cdfhView.setUint16(32, 0, true); // comment length
    cdfhView.setUint16(34, 0, true); // disk number start
    cdfhView.setUint16(36, 0, true); // internal file attrs
    cdfhView.setUint32(38, 0, true); // external file attrs
    cdfhView.setUint32(42, offset, true); // relative offset of local header
    cdfh.set(nameBytes, 46);

    centralChunks.push(cdfh);
    offset += lfh.length + compressed.length;
  }

  const centralDirectorySize = centralChunks.reduce((acc, c) => acc + c.length, 0);

  // End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true); // signature
  eocdView.setUint16(4, 0, true); // disk number
  eocdView.setUint16(6, 0, true); // start disk
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, centralDirectorySize, true);
  eocdView.setUint32(16, offset, true); // offset of start of central directory
  eocdView.setUint16(20, 0, true); // comment length

  const totalSize = offset + centralDirectorySize + eocd.length;
  const output = new Uint8Array(totalSize);
  let cursor = 0;

  for (const chunk of localChunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  for (const chunk of centralChunks) {
    output.set(chunk, cursor);
    cursor += chunk.length;
  }
  output.set(eocd, cursor);

  return output;
}
