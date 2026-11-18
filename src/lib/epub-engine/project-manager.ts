import {
  DEFAULT_LIMITS,
  type BookMetadata,
  type ChapterItem,
  type ConversionIssue,
  type EngineLimits,
  type EpubProjectState,
  type ImageAsset,
  type RawInputFile,
} from './types';
import {
  buildSafeEpubImagePath,
  getBaseName,
  isCandidateImageFileName,
  isHtmlFileName,
  sanitizeRelativePath,
} from './file-map';
import {
  convertImageBytesToPngInBrowser,
  detectImageFormat,
  inspectImageDimensions,
} from './image-utils';
import { buildChapterPreviewHtml, parseAndSanitizeChapter } from './sanitizer';
import { rewriteBookLinks } from './link-rewriter';

const textDecoder = new TextDecoder('utf-8', { fatal: false });

export function createEmptyProject(): EpubProjectState {
  const randomSuffix =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-4000-8000-000000000001`;
  return {
    chapters: [],
    images: [],
    metadata: {
      title: 'Untitled Ebook',
      author: 'Unknown Author',
      language: 'en',
      identifier: `urn:uuid:${randomSuffix}`,
      description: '',
      coverImageId: null,
      generateDefaultCover: true,
      includeInBookToc: false,
    },
    issues: [],
    totalInputBytes: 0,
    importedFileCount: 0,
    allowMissingImages: false,
  };
}

function generateLocalId(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}-${Date.now().toString(36)}`;
}

/**
 * Imports a batch of raw HTML and image files into an existing or empty project state.
 * Enforces explicit file count, per-file size, total project size, and image pixel limits.
 * Handles duplicate image filenames across subfolders by tracking full relative paths and
 * assigning distinct internal EPUB paths (`images/img-01-...`).
 */
export async function importRawFilesIntoProject(
  currentProject: EpubProjectState,
  rawFiles: RawInputFile[],
  limits: EngineLimits = DEFAULT_LIMITS
): Promise<EpubProjectState> {
  const issues: ConversionIssue[] = [...currentProject.issues.filter((i) => i.severity === 'error' ? false : true)];
  const images: ImageAsset[] = [...currentProject.images];
  let totalBytes = currentProject.totalInputBytes;
  let importedFileCount = currentProject.importedFileCount;

  const htmlInputs: Array<{ path: string; rawHtml: string; size: number }> = [];

  // Track duplicate image basenames for user transparency
  const basenameCounts = new Map<string, number>();
  for (const existing of images) {
    basenameCounts.set(
      existing.basename.toLowerCase(),
      (basenameCounts.get(existing.basename.toLowerCase()) ?? 0) + 1
    );
  }

  for (const file of rawFiles) {
    const cleanPath = sanitizeRelativePath(file.relativePath);
    const basename = getBaseName(cleanPath);

    // Skip hidden system files such as .DS_Store or Thumbs.db quietly
    if (basename.startsWith('.') || basename.toLowerCase() === 'thumbs.db') {
      continue;
    }

    if (importedFileCount >= limits.maxFileCount) {
      issues.push({
        id: generateLocalId('limit-count'),
        severity: 'error',
        code: 'LIMIT_FILE_COUNT',
        message: `File count limit reached (${limits.maxFileCount} files max). Skipped "${cleanPath}". Split large collections into smaller volumes.`,
        sourcePath: cleanPath,
      });
      continue;
    }

    if (totalBytes + file.size > limits.maxTotalBytes) {
      issues.push({
        id: generateLocalId('limit-total'),
        severity: 'error',
        code: 'LIMIT_TOTAL_SIZE',
        message: `Total project size would exceed ${(limits.maxTotalBytes / (1024 * 1024)).toFixed(0)} MB limit with "${cleanPath}". Remove large images or split chapters.`,
        sourcePath: cleanPath,
      });
      continue;
    }

    if (isHtmlFileName(cleanPath)) {
      if (file.size > limits.maxSingleHtmlBytes) {
        issues.push({
          id: generateLocalId('limit-html'),
          severity: 'error',
          code: 'LIMIT_SINGLE_HTML_SIZE',
          message: `HTML file "${cleanPath}" (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds the ${(limits.maxSingleHtmlBytes / (1024 * 1024)).toFixed(0)} MB per-chapter limit.`,
          sourcePath: cleanPath,
        });
        continue;
      }

      if (currentProject.chapters.length + htmlInputs.length >= limits.maxChapterCount) {
        issues.push({
          id: generateLocalId('limit-ch'),
          severity: 'error',
          code: 'LIMIT_CHAPTER_COUNT',
          message: `Chapter limit reached (${limits.maxChapterCount} chapters max). Skipped "${cleanPath}".`,
          sourcePath: cleanPath,
        });
        continue;
      }

      const rawHtml = textDecoder.decode(file.bytes);
      htmlInputs.push({ path: cleanPath, rawHtml, size: file.size });
      totalBytes += file.size;
      importedFileCount += 1;
      continue;
    }

    if (isCandidateImageFileName(cleanPath)) {
      if (file.size > limits.maxSingleImageBytes) {
        issues.push({
          id: generateLocalId('limit-img-size'),
          severity: 'error',
          code: 'LIMIT_SINGLE_IMAGE_SIZE',
          message: `Image "${cleanPath}" (${(file.size / (1024 * 1024)).toFixed(2)} MB) exceeds the ${(limits.maxSingleImageBytes / (1024 * 1024)).toFixed(0)} MB image size limit.`,
          sourcePath: cleanPath,
        });
        continue;
      }

      const fmt = detectImageFormat(cleanPath, file.bytes, file.mimeType);
      let finalBytes = file.bytes;
      let mediaType: 'image/jpeg' | 'image/png' | null =
        fmt === 'jpeg' ? 'image/jpeg' : fmt === 'png' ? 'image/png' : null;
      let convertedFrom: string | undefined;
      let dimensions = inspectImageDimensions(file.bytes, file.mimeType);

      if (!mediaType) {
        if (fmt === 'webp' || fmt === 'gif' || fmt === 'bmp') {
          const converted = await convertImageBytesToPngInBrowser(
            file.bytes,
            file.mimeType || `image/${fmt}`
          );
          if (converted) {
            finalBytes = converted.bytes;
            mediaType = 'image/png';
            convertedFrom = fmt.toUpperCase();
            dimensions = {
              width: converted.width,
              height: converted.height,
              pixels: converted.width * converted.height,
            };
            issues.push({
              id: generateLocalId('img-conv'),
              severity: 'warning',
              code: 'IMAGE_CONVERTED_TO_PNG',
              message: `Converted "${cleanPath}" from ${convertedFrom} to PNG for broad e-reader compatibility.`,
              sourcePath: cleanPath,
            });
          } else {
            issues.push({
              id: generateLocalId('img-unsupported'),
              severity: 'warning',
              code: 'UNSUPPORTED_IMAGE_FORMAT',
              message: `Image "${cleanPath}" (${fmt.toUpperCase()}) could not be converted automatically in this environment. Phase 1 prioritizes JPEG and PNG.`,
              sourcePath: cleanPath,
            });
            continue;
          }
        } else {
          issues.push({
            id: generateLocalId('img-unsupported'),
            severity: 'warning',
            code: 'UNSUPPORTED_IMAGE_FORMAT',
            message: `Image "${cleanPath}" (${fmt === 'svg' ? 'SVG' : 'unknown format'}) is not supported in Phase 1. Use JPEG or PNG images instead.`,
            sourcePath: cleanPath,
          });
          continue;
        }
      }

      if (dimensions && dimensions.pixels > limits.maxImagePixels) {
        issues.push({
          id: generateLocalId('limit-pixels'),
          severity: 'error',
          code: 'LIMIT_IMAGE_PIXELS',
          message: `Image "${cleanPath}" (${dimensions.width}×${dimensions.height} = ${(dimensions.pixels / 1_000_000).toFixed(1)} MP) exceeds the ${(limits.maxImagePixels / 1_000_000).toFixed(0)} MP pixel limit.`,
          sourcePath: cleanPath,
        });
        continue;
      }

      const lowerBase = basename.toLowerCase();
      const prevCount = basenameCounts.get(lowerBase) ?? 0;
      basenameCounts.set(lowerBase, prevCount + 1);

      const epubPath = buildSafeEpubImagePath(images.length, cleanPath, mediaType);
      if (prevCount > 0) {
        issues.push({
          id: generateLocalId('dup-img'),
          severity: 'warning',
          code: 'DUPLICATE_IMAGE_RENAMED',
          message: `Multiple images share filename "${basename}". Kept "${cleanPath}" as "${epubPath}" inside the EPUB package without overwriting.`,
          sourcePath: cleanPath,
        });
      }

      // Replace if exact same sourcePath already existed
      const existingIdx = images.findIndex((i) => i.sourcePath === cleanPath);
      const asset: ImageAsset = {
        id: existingIdx >= 0 ? images[existingIdx]!.id : generateLocalId('img'),
        sourcePath: cleanPath,
        basename,
        epubPath: existingIdx >= 0 ? images[existingIdx]!.epubPath : epubPath,
        mediaType,
        originalFormat: fmt,
        convertedFrom,
        bytes: finalBytes,
        size: finalBytes.length,
        dimensions,
        usedInChapterIds: [],
        isCoverCandidate: true,
      };
      if (existingIdx >= 0) {
        images[existingIdx] = asset;
      } else {
        images.push(asset);
      }

      totalBytes += finalBytes.length;
      importedFileCount += 1;
      continue;
    }

    // Ignore non-HTML/non-image companion files (like saved .css/.js in _files folders) with a gentle warning
    issues.push({
      id: generateLocalId('unsupported-file'),
      severity: 'warning',
      code: 'UNSUPPORTED_FILE_TYPE',
      message: `Skipped non-book asset "${cleanPath}". Only HTML/HTM chapters and JPEG/PNG images are packaged into EPUB.`,
      sourcePath: cleanPath,
    });
  }

  // Re-parse existing chapters if new images were added (so newly uploaded missing images attach automatically!)
  const allRawChapters = [
    ...currentProject.chapters.map((ch) => ({
      id: ch.id,
      path: ch.sourcePath,
      rawHtml: ch.rawHtml,
      size: ch.byteSize,
      customTitle: ch.title,
    })),
    ...htmlInputs.map((h) => ({
      id: generateLocalId('ch'),
      path: h.path,
      rawHtml: h.rawHtml,
      size: h.size,
      customTitle: undefined,
    })),
  ];

  // Clear usedInChapterIds before re-matching
  for (const img of images) {
    img.usedInChapterIds = [];
  }

  const nextChapters: ChapterItem[] = [];
  const parseIssues: ConversionIssue[] = [];

  for (let idx = 0; idx < allRawChapters.length; idx += 1) {
    const item = allRawChapters[idx]!;
    const { chapter, issues: chIssues } = parseAndSanitizeChapter({
      id: item.id,
      sourcePath: item.path,
      rawHtml: item.rawHtml,
      byteSize: item.size,
      chapterIndex: idx,
      images,
      customTitle: item.customTitle,
    });
    nextChapters.push(chapter);
    parseIssues.push(...chIssues);
  }

  // Detect cross-chapter & broken internal links immediately on import so diagnostics show them pre-export
  const linkPreviewResult = rewriteBookLinks(nextChapters);
  for (const ch of nextChapters) {
    ch.linkRefs = linkPreviewResult.linkRefsByChapterId[ch.id] ?? [];
    const rewrittenBody = linkPreviewResult.rewrittenBodiesByChapterId[ch.id];
    if (rewrittenBody) {
      ch.previewHtml = buildChapterPreviewHtml(rewrittenBody, images);
    }
  }

  // Keep import-time issues (limits, converted images, duplicates, unsupported files) + fresh parse + link issues
  const importLevelIssues = issues.filter(
    (i) =>
      i.code === 'LIMIT_FILE_COUNT' ||
      i.code === 'LIMIT_CHAPTER_COUNT' ||
      i.code === 'LIMIT_SINGLE_HTML_SIZE' ||
      i.code === 'LIMIT_SINGLE_IMAGE_SIZE' ||
      i.code === 'LIMIT_TOTAL_SIZE' ||
      i.code === 'LIMIT_IMAGE_PIXELS' ||
      i.code === 'UNSUPPORTED_FILE_TYPE' ||
      i.code === 'UNSUPPORTED_IMAGE_FORMAT' ||
      i.code === 'IMAGE_CONVERTED_TO_PNG' ||
      i.code === 'DUPLICATE_IMAGE_RENAMED'
  );

  // Suggest initial book title from first chapter if metadata still has default title
  let nextMetadata: BookMetadata = { ...currentProject.metadata };
  if (
    nextChapters.length > 0 &&
    (nextMetadata.title === 'Untitled Ebook' || !nextMetadata.title.trim())
  ) {
    nextMetadata = {
      ...nextMetadata,
      title: nextChapters[0]!.title,
    };
  }

  return {
    chapters: nextChapters,
    images,
    metadata: nextMetadata,
    issues: [...importLevelIssues, ...parseIssues, ...linkPreviewResult.issues],
    totalInputBytes: totalBytes,
    importedFileCount,
    allowMissingImages: currentProject.allowMissingImages,
  };
}

export function reorderChapter(
  project: EpubProjectState,
  fromIndex: number,
  toIndex: number
): EpubProjectState {
  if (
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= project.chapters.length ||
    toIndex >= project.chapters.length ||
    fromIndex === toIndex
  ) {
    return project;
  }

  const next = [...project.chapters];
  const [moved] = next.splice(fromIndex, 1);
  if (!moved) return project;
  next.splice(toIndex, 0, moved);

  const reindexed = next.map((ch, idx) => ({
    ...ch,
    epubPath: `chapters/chapter-${String(idx + 1).padStart(3, '0')}.xhtml`,
  }));

  return {
    ...project,
    chapters: reindexed,
  };
}

export function renameChapter(
  project: EpubProjectState,
  chapterId: string,
  newTitle: string
): EpubProjectState {
  return {
    ...project,
    chapters: project.chapters.map((ch) =>
      ch.id === chapterId ? { ...ch, title: newTitle } : ch
    ),
  };
}

export function deleteChapter(
  project: EpubProjectState,
  chapterId: string
): EpubProjectState {
  const remaining = project.chapters
    .filter((ch) => ch.id !== chapterId)
    .map((ch, idx) => ({
      ...ch,
      epubPath: `chapters/chapter-${String(idx + 1).padStart(3, '0')}.xhtml`,
    }));

  const remainingIssues = project.issues.filter((i) => i.chapterId !== chapterId);
  return {
    ...project,
    chapters: remaining,
    issues: remainingIssues,
  };
}

/**
 * Attaches an uploaded image file directly to a missing image reference path (resolving it cleanly).
 */
export async function attachMissingImageFile(
  project: EpubProjectState,
  missingRawSrc: string,
  file: RawInputFile
): Promise<EpubProjectState> {
  const fmt = detectImageFormat(file.relativePath, file.bytes, file.mimeType);
  let bytes = file.bytes;
  let mediaType: 'image/jpeg' | 'image/png' | null =
    fmt === 'jpeg' ? 'image/jpeg' : fmt === 'png' ? 'image/png' : null;
  if (!mediaType && (fmt === 'webp' || fmt === 'gif' || fmt === 'bmp')) {
    const converted = await convertImageBytesToPngInBrowser(
      file.bytes,
      file.mimeType || `image/${fmt}`
    );
    if (converted) {
      bytes = converted.bytes;
      mediaType = 'image/png';
    }
  }
  if (!mediaType) {
    return {
      ...project,
      issues: [
        ...project.issues,
        {
          id: generateLocalId('attach-err'),
          severity: 'error',
          code: 'UNSUPPORTED_IMAGE_FORMAT',
          message: `Cannot attach "${file.relativePath}" to "${missingRawSrc}": only JPEG or PNG images are supported.`,
          sourcePath: file.relativePath,
        },
      ],
    };
  }

  const targetRelative = sanitizeRelativePath(missingRawSrc);
  const newAsset: ImageAsset = {
    id: generateLocalId('img'),
    sourcePath: targetRelative || getBaseName(file.relativePath),
    basename: getBaseName(targetRelative || file.relativePath),
    epubPath: buildSafeEpubImagePath(
      project.images.length,
      targetRelative || file.relativePath,
      mediaType
    ),
    mediaType,
    originalFormat: fmt,
    bytes,
    size: bytes.length,
    dimensions: inspectImageDimensions(bytes, mediaType),
    usedInChapterIds: [],
    isCoverCandidate: true,
  };

  const nextImages = [...project.images, newAsset];
  const nextChapters: ChapterItem[] = [];
  const nextParseIssues: ConversionIssue[] = [];

  for (let idx = 0; idx < project.chapters.length; idx += 1) {
    const ch = project.chapters[idx]!;
    const { chapter, issues } = parseAndSanitizeChapter({
      id: ch.id,
      sourcePath: ch.sourcePath,
      rawHtml: ch.rawHtml,
      byteSize: ch.byteSize,
      chapterIndex: idx,
      images: nextImages,
      customTitle: ch.title,
    });
    nextChapters.push({
      ...chapter,
      previewHtml: buildChapterPreviewHtml(chapter.sanitizedBodyHtml, nextImages),
    });
    nextParseIssues.push(...issues);
  }

  const importLevelIssues = project.issues.filter(
    (i) =>
      i.code !== 'MISSING_IMAGE' &&
      i.code !== 'STRIPPED_UNSAFE_CONTENT' &&
      i.code !== 'DUPLICATE_ID_FIXED' &&
      i.code !== 'REMOTE_RESOURCE_BLOCKED' &&
      i.code !== 'EMPTY_CHAPTER_CONTENT'
  );

  return {
    ...project,
    images: nextImages,
    chapters: nextChapters,
    issues: [...importLevelIssues, ...nextParseIssues],
    totalInputBytes: project.totalInputBytes + bytes.length,
    importedFileCount: project.importedFileCount + 1,
  };
}
