import type { ImageAsset, RawInputFile } from './types';

/**
 * Strips Windows drive letters, UNC prefixes, leading slashes, and collapses
 * redundant path separators to keep only safe relative paths inside the project.
 */
export function sanitizeRelativePath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, '/').trim();
  // Remove file:// scheme if accidentally included
  normalized = normalized.replace(/^file:\/+/i, '');
  // Remove Windows drive letter e.g. C:/
  normalized = normalized.replace(/^[a-zA-Z]:\//, '');
  // Remove leading slashes or ./
  normalized = normalized.replace(/^\/+/, '').replace(/^(\.\/)+/, '');

  const segments: string[] = [];
  for (const part of normalized.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

/**
 * Strips the shared root folder when users select a single directory via `webkitdirectory`,
 * unless there are files directly at root or multiple top-level directories.
 */
export function normalizeFolderBatchPaths(paths: string[]): string[] {
  const cleaned = paths.map((p) => sanitizeRelativePath(p));
  if (cleaned.length <= 1) return cleaned;

  const firstSegments = cleaned.map((p) => (p.includes('/') ? p.split('/')[0] : ''));
  const first = firstSegments[0];
  if (first && firstSegments.every((seg) => seg === first)) {
    return cleaned.map((p) => p.slice(first.length + 1));
  }
  return cleaned;
}

export function getDirName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

export function getBaseName(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

export function stripQueryAndHash(rawRef: string): {
  pathPart: string;
  hashPart: string;
} {
  const hashIdx = rawRef.indexOf('#');
  const withoutHash = hashIdx === -1 ? rawRef : rawRef.slice(0, hashIdx);
  const hashPart = hashIdx === -1 ? '' : rawRef.slice(hashIdx + 1);
  const queryIdx = withoutHash.indexOf('?');
  const pathPart = queryIdx === -1 ? withoutHash : withoutHash.slice(0, queryIdx);
  return { pathPart: pathPart.trim(), hashPart: hashPart.trim() };
}

export function safeDecodeUri(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves a relative URI inside a chapter's directory to a normalized project-relative path.
 */
export function resolveRelativeReference(
  chapterRelativePath: string,
  rawRef: string
): string {
  const { pathPart } = stripQueryAndHash(rawRef);
  const decoded = safeDecodeUri(pathPart).replace(/\\/g, '/').trim();
  if (!decoded) return sanitizeRelativePath(chapterRelativePath);

  const chapterDir = getDirName(sanitizeRelativePath(chapterRelativePath));
  const combined = decoded.startsWith('/')
    ? decoded.slice(1)
    : chapterDir
      ? `${chapterDir}/${decoded}`
      : decoded;

  const segments: string[] = [];
  for (const part of combined.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (segments.length > 0) segments.pop();
      continue;
    }
    segments.push(part);
  }
  return segments.join('/');
}

export function isRemoteOrExternalAssetUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim().toLowerCase();
  return (
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://') ||
    trimmed.startsWith('//') ||
    trimmed.startsWith('ftp://') ||
    trimmed.startsWith('file://')
  );
}

export function isHtmlFileName(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm') || lower.endsWith('.xhtml');
}

export function isCandidateImageFileName(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith('.jpg') ||
    lower.endsWith('.jpeg') ||
    lower.endsWith('.png') ||
    lower.endsWith('.webp') ||
    lower.endsWith('.gif') ||
    lower.endsWith('.bmp') ||
    lower.endsWith('.svg')
  );
}

/**
 * Generates an ASCII-safe, deterministic EPUB-internal image filename that avoids collisions
 * across folders and strips non-ASCII or unsafe characters from ZIP manifest paths.
 */
export function buildSafeEpubImagePath(
  index: number,
  sourcePath: string,
  mediaType: 'image/jpeg' | 'image/png'
): string {
  const ext = mediaType === 'image/jpeg' ? 'jpg' : 'png';
  const base = getBaseName(sourcePath);
  const dotIdx = base.lastIndexOf('.');
  const stem = dotIdx > 0 ? base.slice(0, dotIdx) : base;
  const asciiStem = stem
    .normalize('NFKD')
    .replace(/[^\w-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .toLowerCase();
  const safeStem = asciiStem ? asciiStem.slice(0, 36) : 'image';
  const num = String(index + 1).padStart(2, '0');
  return `images/img-${num}-${safeStem}.${ext}`;
}

/**
 * Matches a chapter `<img src>` against imported `ImageAsset` entries.
 * Order of precedence:
 * 1. Exact relative path match (case-sensitive then case-insensitive)
 * 2. Suffix match (e.g. saved webpage `<img src="post_files/pic.png">` vs imported `pic.png` or vice versa)
 * 3. Unique basename match (if only 1 image shares that filename; or prefer one in same subfolder)
 */
export function matchImageAsset(
  chapterSourcePath: string,
  rawSrc: string,
  images: ImageAsset[]
): { resolvedPath: string; matched: ImageAsset | null } {
  const resolvedPath = resolveRelativeReference(chapterSourcePath, rawSrc);
  if (images.length === 0) {
    return { resolvedPath, matched: null };
  }

  // 1. Exact relative match
  const exact = images.find((img) => img.sourcePath === resolvedPath);
  if (exact) return { resolvedPath, matched: exact };

  const lowerResolved = resolvedPath.toLowerCase();
  const exactCI = images.find((img) => img.sourcePath.toLowerCase() === lowerResolved);
  if (exactCI) return { resolvedPath, matched: exactCI };

  // 2. Suffix match (handles browser Save Page As folder offsets)
  const suffixMatches = images.filter(
    (img) =>
      img.sourcePath.toLowerCase().endsWith(`/${lowerResolved}`) ||
      lowerResolved.endsWith(`/${img.sourcePath.toLowerCase()}`)
  );
  if (suffixMatches.length === 1) {
    return { resolvedPath, matched: suffixMatches[0] ?? null };
  }

  // 3. Basename fallback
  const targetBase = getBaseName(resolvedPath).toLowerCase();
  const baseMatches = images.filter((img) => img.basename.toLowerCase() === targetBase);
  if (baseMatches.length === 1) {
    return { resolvedPath, matched: baseMatches[0] ?? null };
  }

  // When multiple folders share the same image filename (e.g. ch1/fig1.png & ch2/fig1.png),
  // prefer the asset sitting inside the chapter's directory tree.
  if (baseMatches.length > 1) {
    const chapterDir = getDirName(sanitizeRelativePath(chapterSourcePath)).toLowerCase();
    if (chapterDir) {
      const sameDir = baseMatches.find((img) =>
        img.sourcePath.toLowerCase().startsWith(`${chapterDir}/`)
      );
      if (sameDir) return { resolvedPath, matched: sameDir };
    }
    // Check if rawSrc had a subfolder prefix matching one of the candidate paths
    const cleanRaw = sanitizeRelativePath(stripQueryAndHash(safeDecodeUri(rawSrc)).pathPart).toLowerCase();
    const rawMatched = baseMatches.find((img) => img.sourcePath.toLowerCase().endsWith(cleanRaw));
    if (rawMatched) return { resolvedPath, matched: rawMatched };
  }

  return { resolvedPath, matched: null };
}

export async function fileListToRawInputs(files: FileList | File[]): Promise<RawInputFile[]> {
  const arr = Array.from(files);
  const paths = arr.map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath;
    return rel && rel.length > 0 ? rel : f.name;
  });
  const normalizedPaths = normalizeFolderBatchPaths(paths);

  const results: RawInputFile[] = [];
  for (let i = 0; i < arr.length; i += 1) {
    const file = arr[i];
    if (!file) continue;
    const buffer = await file.arrayBuffer();
    results.push({
      relativePath: normalizedPaths[i] ?? sanitizeRelativePath(file.name),
      size: file.size,
      mimeType: file.type,
      bytes: new Uint8Array(buffer),
    });
  }
  return results;
}
