import createDOMPurify from 'dompurify';
import type { ChapterItem, ConversionIssue, ImageAsset, TocHeading } from './types';
import {
  getBaseName,
  isRemoteOrExternalAssetUrl,
  matchImageAsset,
  sanitizeRelativePath,
} from './file-map';
import { imageToDataUri } from './image-utils';

const ALLOWED_EPUB_TAGS = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'figure',
  'figcaption',
  'img',
  'a',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'sub',
  'sup',
  'mark',
  'small',
  'abbr',
  'cite',
  'q',
  'dfn',
  'time',
  'hr',
  'br',
  'span',
  'div',
  'section',
  'article',
];

const ALLOWED_EPUB_ATTRS = [
  'href',
  'src',
  'alt',
  'title',
  'id',
  'colspan',
  'rowspan',
  'scope',
  'lang',
  'xml:lang',
  'dir',
];

const FORBIDDEN_CONTAINER_TAGS = [
  'script',
  'noscript',
  'style',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'form',
  'input',
  'textarea',
  'select',
  'button',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'canvas',
  'audio',
  'video',
  'source',
  'template',
];

const INLINE_BLOCK_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'cite',
  'code',
  'del',
  'dfn',
  'em',
  'i',
  'img',
  'ins',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strong',
  'sub',
  'sup',
  'time',
  'u',
  'var',
  'br',
]);

function getDOMPurifyInstance(): ReturnType<typeof createDOMPurify> {
  if (typeof window === 'undefined') {
    throw new Error('DOM environment is required to sanitize HTML chapters.');
  }
  return createDOMPurify(window as unknown as Parameters<typeof createDOMPurify>[0]);
}

function parseRawHtmlDocument(rawHtml: string): Document {
  const parser = new DOMParser();
  // DOMParser parses into an inert document without executing scripts or fetching subresources
  return parser.parseFromString(rawHtml, 'text/html');
}

/**
 * Ensures an ID conforms to XML NCName (`^[A-Za-z_][A-Za-z0-9_.-]*$`) and is unique within a chapter.
 */
export function toUniqueXmlId(
  rawId: string,
  usedIds: Set<string>,
  fallbackPrefix = 'sec'
): string {
  let cleaned = rawId
    .trim()
    .replace(/[^\w.-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  if (!cleaned || !/^[A-Za-z_]/.test(cleaned)) {
    cleaned = `${fallbackPrefix}-${cleaned || 'node'}`;
  }

  let candidate = cleaned;
  let counter = 2;
  while (usedIds.has(candidate)) {
    candidate = `${cleaned}-${counter}`;
    counter += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function countWords(text: string): number {
  const cleaned = text.trim();
  if (!cleaned) return 0;
  // Count CJK characters individually + whitespace-separated Latin/alphanumeric words
  const cjkMatches = cleaned.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
  const latinPart = cleaned.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, ' ');
  const latinWords = latinPart.trim() ? latinPart.trim().split(/\s+/).length : 0;
  return (cjkMatches?.length ?? 0) + latinWords;
}

function deriveTitleFromFilename(fileName: string): string {
  const base = getBaseName(fileName);
  const stem = base.replace(/\.(html?|xhtml)$/i, '');
  const formatted = stem.replace(/[-_]+/g, ' ').trim();
  return formatted || 'Untitled Chapter';
}

/**
 * Strips leading numerical order prefixes (e.g. "1. ", "02 - ", "3) ") so numbered TOC views
 * never display doubled numbering like "1. 2. Chapter" after chapters are reordered.
 */
export function stripLeadingOrderNumber(title: string): string {
  const trimmed = title.trim();
  const stripped = trimmed.replace(/^\d{1,3}\s*[\.\)\-:–—]\s+/, '').trim();
  return stripped || trimmed;
}

function isUnsafeUrl(url: string): boolean {
  const normalized = url.replace(/[\u0000-\u0020]+/g, '').toLowerCase();
  return (
    normalized.startsWith('javascript:') ||
    normalized.startsWith('vbscript:') ||
    normalized.startsWith('data:text/html') ||
    normalized.startsWith('data:application/')
  );
}

/**
 * Unwraps or removes malformed nested structures (e.g., <div> inside <span> or <p>)
 * and wraps bare top-level text/inline nodes into <p> so EPUB 3 XHTML body validates cleanly.
 */
function normalizeBlockStructure(bodyEl: HTMLElement, doc: Document): void {
  // Unwrap nested <a> inside <a> (disallowed in XHTML5)
  for (const anchor of Array.from(bodyEl.querySelectorAll('a a'))) {
    const span = doc.createElement('span');
    while (anchor.firstChild) {
      span.appendChild(anchor.firstChild);
    }
    anchor.replaceWith(span);
  }

  // Ensure <ul>/<ol> only have <li> element children
  for (const listEl of Array.from(bodyEl.querySelectorAll('ul, ol'))) {
    for (const child of Array.from(listEl.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = (child.textContent ?? '').trim();
        if (!text) {
          child.remove();
        } else {
          const li = doc.createElement('li');
          li.textContent = text;
          child.replaceWith(li);
        }
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const cTag = (child as Element).tagName.toLowerCase();
        if (cTag !== 'li') {
          const li = doc.createElement('li');
          child.replaceWith(li);
          li.appendChild(child);
        }
      }
    }
    if (listEl.children.length === 0) {
      listEl.remove();
    }
  }

  // Hoist block children out of inline tags (e.g. <span><div>...</div></span> or <p><div>...</div></p>)
  const inlineOrPara = Array.from(bodyEl.querySelectorAll('span, a, em, strong, b, i, u, s, small, p'));
  for (const el of inlineOrPara) {
    const tag = el.tagName.toLowerCase();
    const nestedBlocks = Array.from(el.children).filter((child) => {
      const cTag = child.tagName.toLowerCase();
      return (
        cTag === 'div' ||
        cTag === 'p' ||
        cTag === 'section' ||
        cTag === 'article' ||
        cTag === 'table' ||
        cTag === 'ul' ||
        cTag === 'ol' ||
        cTag === 'blockquote' ||
        cTag === 'pre' ||
        cTag === 'figure' ||
        cTag === 'h1' ||
        cTag === 'h2' ||
        cTag === 'h3' ||
        cTag === 'h4' ||
        cTag === 'h5' ||
        cTag === 'h6'
      );
    });
    if (nestedBlocks.length > 0 && (tag === 'span' || tag === 'p' || tag === 'a' || tag === 'em' || tag === 'strong' || tag === 'b' || tag === 'i')) {
      const parent = el.parentNode;
      if (parent) {
        for (const block of nestedBlocks) {
          parent.insertBefore(block, el.nextSibling);
        }
      }
    }
  }

  // Wrap bare top-level text or inline nodes in <p>
  const children = Array.from(bodyEl.childNodes);
  let pendingInline: Node[] = [];

  const flushPending = () => {
    const hasMeaningfulContent = pendingInline.some(
      (n) => n.nodeType !== Node.TEXT_NODE || (n.textContent ?? '').trim().length > 0
    );
    if (hasMeaningfulContent) {
      const p = doc.createElement('p');
      const first = pendingInline[0];
      if (first && first.parentNode === bodyEl) {
        bodyEl.insertBefore(p, first);
      } else {
        bodyEl.appendChild(p);
      }
      for (const node of pendingInline) {
        p.appendChild(node);
      }
    } else {
      for (const node of pendingInline) {
        if (node.parentNode === bodyEl) bodyEl.removeChild(node);
      }
    }
    pendingInline = [];
  };

  for (const node of children) {
    if (node.nodeType === Node.TEXT_NODE) {
      pendingInline.push(node);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = (node as Element).tagName.toLowerCase();
      if (INLINE_BLOCK_TAGS.has(tag)) {
        pendingInline.push(node);
      } else {
        flushPending();
      }
    }
  }
  flushPending();
}

export function parseAndSanitizeChapter(params: {
  id: string;
  sourcePath: string;
  rawHtml: string;
  byteSize: number;
  chapterIndex: number;
  images: ImageAsset[];
  customTitle?: string;
}): { chapter: ChapterItem; issues: ConversionIssue[] } {
  const { id, sourcePath, rawHtml, byteSize, chapterIndex, images, customTitle } = params;
  const cleanSourcePath = sanitizeRelativePath(sourcePath);
  const fileName = getBaseName(cleanSourcePath);
  const epubPath = `chapters/chapter-${String(chapterIndex + 1).padStart(3, '0')}.xhtml`;
  const issues: ConversionIssue[] = [];

  const rawDoc = parseRawHtmlDocument(rawHtml);

  // 1. Audit dangerous content before sanitizing so we can produce accurate diagnostic logs
  let scripts = 0;
  let eventAttributes = 0;
  let formsAndInputs = 0;
  let iframesAndObjects = 0;
  let unsafeUrls = 0;
  let remoteStylesOrScripts = 0;

  for (const el of Array.from(rawDoc.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'script') scripts += 1;
    if (tag === 'form' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') {
      formsAndInputs += 1;
    }
    if (tag === 'iframe' || tag === 'frame' || tag === 'object' || tag === 'embed' || tag === 'applet') {
      iframesAndObjects += 1;
    }
    if (tag === 'link') {
      const href = el.getAttribute('href') ?? '';
      if (isRemoteOrExternalAssetUrl(href)) remoteStylesOrScripts += 1;
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        eventAttributes += 1;
      } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && isUnsafeUrl(attr.value)) {
        unsafeUrls += 1;
      }
    }
  }

  // Extract candidate document title from <title> or first heading before stripping
  const docTitleText = rawDoc.querySelector('title')?.textContent?.trim() ?? '';
  const firstHeadingText = rawDoc.body?.querySelector('h1, h2')?.textContent?.trim() ?? '';
  const resolvedTitle =
    customTitle?.trim() || firstHeadingText || docTitleText || deriveTitleFromFilename(fileName);

  // Strip known container/non-book blocks explicitly so their inner text never leaks
  for (const forbiddenTag of FORBIDDEN_CONTAINER_TAGS) {
    for (const node of Array.from(rawDoc.body?.querySelectorAll(forbiddenTag) ?? [])) {
      node.remove();
    }
  }

  // Remove any remaining inline event handlers and unsafe href/src attributes prior to DOMPurify
  for (const el of Array.from(rawDoc.body?.querySelectorAll('*') ?? [])) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if ((name === 'href' || name === 'src') && isUnsafeUrl(attr.value)) {
        if (tagNeedsTextPreservation(el.tagName.toLowerCase())) {
          el.removeAttribute(attr.name);
        } else {
          el.remove();
        }
      }
    }
  }

  // 2. Sanitize with DOMPurify using strict allowlist
  const DOMPurify = getDOMPurifyInstance();
  const bodyHtmlRaw = rawDoc.body ? rawDoc.body.innerHTML : rawHtml;
  const cleanHtml = DOMPurify.sanitize(bodyHtmlRaw, {
    ALLOWED_TAGS: ALLOWED_EPUB_TAGS,
    ALLOWED_ATTR: ALLOWED_EPUB_ATTRS,
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: true,
    RETURN_TRUSTED_TYPE: false,
  });

  // 3. Re-parse sanitized markup into an inert DOM to normalize IDs, headings, images & block structure
  const cleanDoc = parseRawHtmlDocument(`<!DOCTYPE html><html><body>${cleanHtml}</body></html>`);
  const body = cleanDoc.body;

  normalizeBlockStructure(body, cleanDoc);

  // Ensure all IDs are unique XML NCNames
  const usedIds = new Set<string>();
  const seenRawIds = new Set<string>();
  const idMap: Record<string, string> = {};
  let duplicateIdsFixed = 0;

  for (const el of Array.from(body.querySelectorAll('[id]'))) {
    const originalId = el.getAttribute('id') ?? '';
    if (!originalId.trim()) {
      el.removeAttribute('id');
      continue;
    }
    const alreadySeen = usedIds.has(originalId) || seenRawIds.has(originalId);
    seenRawIds.add(originalId);
    const uniqueId = toUniqueXmlId(originalId, usedIds, 'id');
    if (alreadySeen || uniqueId !== originalId) {
      duplicateIdsFixed += 1;
    }
    if (!(originalId in idMap)) {
      idMap[originalId] = uniqueId;
      idMap[originalId.toLowerCase()] = uniqueId;
    }
    el.setAttribute('id', uniqueId);
  }

  // Collect headings for TOC (h1 - h3)
  const headings: TocHeading[] = [];
  for (const hEl of Array.from(body.querySelectorAll('h1, h2, h3'))) {
    const text = hEl.textContent?.trim() ?? '';
    if (!text) continue;
    let hId = hEl.getAttribute('id');
    if (!hId) {
      hId = toUniqueXmlId(
        `sec-${headings.length + 1}-${text.slice(0, 24)}`,
        usedIds,
        'sec'
      );
      hEl.setAttribute('id', hId);
    }
    const level = Number(hEl.tagName.slice(1)) as 1 | 2 | 3;
    headings.push({ id: hId, text, level });
  }

  // Resolve <img> references against local imported assets (never fetch remote URLs)
  const imageRefs: ChapterItem['imageRefs'] = [];
  const missingImagePaths: string[] = [];

  for (const imgEl of Array.from(body.querySelectorAll('img'))) {
    const rawSrc = (imgEl.getAttribute('src') ?? '').trim();
    const alt = (imgEl.getAttribute('alt') ?? '').trim();
    if (!rawSrc) {
      imgEl.remove();
      continue;
    }

    if (isRemoteOrExternalAssetUrl(rawSrc)) {
      remoteStylesOrScripts += 1;
      issues.push({
        id: `${id}-remote-img-${issues.length}`,
        severity: 'warning',
        code: 'REMOTE_RESOURCE_BLOCKED',
        message: `Blocked external image URL "${rawSrc}" in ${fileName}. Remote assets are never fetched automatically; import local image files instead.`,
        chapterId: id,
        sourcePath: rawSrc,
      });
      const fallbackNote = cleanDoc.createElement('span');
      fallbackNote.setAttribute('class', 'missing-image-note');
      fallbackNote.textContent = alt
        ? `[External image omitted: ${alt}]`
        : `[External image omitted: ${rawSrc}]`;
      imgEl.replaceWith(fallbackNote);
      continue;
    }

    if (rawSrc.toLowerCase().startsWith('data:image/')) {
      // Keep inline data:image/png or data:image/jpeg? Better to strip oversized or unsafe inline images or handle gracefully.
      // For EPUB 3 compliance, non-data images are preferred; keep safe alt if present.
      imgEl.setAttribute('alt', alt || 'Embedded illustration');
      continue;
    }

    const { resolvedPath, matched } = matchImageAsset(cleanSourcePath, rawSrc, images);
    imageRefs.push({
      rawSrc,
      resolvedRelativePath: resolvedPath,
      matchedImageId: matched?.id ?? null,
      alt: alt || getBaseName(resolvedPath),
    });

    if (matched) {
      if (!matched.usedInChapterIds.includes(id)) {
        matched.usedInChapterIds.push(id);
      }
      imgEl.setAttribute('data-epub-image-id', matched.id);
      imgEl.setAttribute('alt', alt || matched.basename);
    } else {
      missingImagePaths.push(rawSrc);
      imgEl.setAttribute('data-missing-src', rawSrc);
      imgEl.setAttribute('alt', alt || `Missing image: ${rawSrc}`);
      issues.push({
        id: `${id}-missing-img-${issues.length}`,
        severity: 'warning',
        code: 'MISSING_IMAGE',
        message: `Missing local image "${rawSrc}" referenced in "${fileName}". Attach the image file or confirm export with a text placeholder.`,
        chapterId: id,
        sourcePath: rawSrc,
        resolved: false,
      });
    }
  }

  // Strip <table> deprecated layout attributes while keeping colspan/rowspan/scope
  for (const tableEl of Array.from(body.querySelectorAll('table'))) {
    // Ensure table doesn't contain stray invalid text nodes directly inside <table> or <tr>
    for (const child of Array.from(tableEl.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE && !(child.textContent ?? '').trim()) {
        child.remove();
      }
    }
  }

  // Record security stripping warning if any hazardous items were removed
  const strippedTotal =
    scripts + eventAttributes + formsAndInputs + iframesAndObjects + unsafeUrls + remoteStylesOrScripts;
  if (strippedTotal > 0) {
    const parts: string[] = [];
    if (scripts > 0) parts.push(`${scripts} <script>`);
    if (eventAttributes > 0) parts.push(`${eventAttributes} inline event handler(s)`);
    if (formsAndInputs > 0) parts.push(`${formsAndInputs} form control(s)`);
    if (iframesAndObjects > 0) parts.push(`${iframesAndObjects} iframe/embed tag(s)`);
    if (unsafeUrls > 0) parts.push(`${unsafeUrls} unsafe URL(s)`);
    if (remoteStylesOrScripts > 0) parts.push(`${remoteStylesOrScripts} remote resource reference(s)`);

    issues.push({
      id: `${id}-stripped`,
      severity: 'warning',
      code: 'STRIPPED_UNSAFE_CONTENT',
      message: `Sanitized "${fileName}": removed ${parts.join(', ')}.`,
      chapterId: id,
      sourcePath: cleanSourcePath,
    });
  }

  if (duplicateIdsFixed > 0) {
    issues.push({
      id: `${id}-dup-ids`,
      severity: 'warning',
      code: 'DUPLICATE_ID_FIXED',
      message: `Renamed ${duplicateIdsFixed} duplicate or invalid element ID(s) in "${fileName}" to satisfy EPUB XML uniqueness rules.`,
      chapterId: id,
      sourcePath: cleanSourcePath,
    });
  }

  const sanitizedBodyHtml = body.innerHTML;
  const wordCount = countWords(body.textContent ?? '');
  if (wordCount === 0 && imageRefs.length === 0) {
    issues.push({
      id: `${id}-empty`,
      severity: 'warning',
      code: 'EMPTY_CHAPTER_CONTENT',
      message: `"${fileName}" produced no visible text or images after HTML cleaning.`,
      chapterId: id,
      sourcePath: cleanSourcePath,
    });
  }

  const previewHtml = buildChapterPreviewHtml(sanitizedBodyHtml, images);

  const chapter: ChapterItem = {
    id,
    sourcePath: cleanSourcePath,
    fileName,
    epubPath,
    title: resolvedTitle,
    rawHtml,
    sanitizedBodyHtml,
    previewHtml,
    headings,
    idMap,
    validIds: Array.from(usedIds),
    imageRefs,
    linkRefs: [],
    missingImagePaths,
    strippedStats: {
      scripts,
      eventAttributes,
      formsAndInputs,
      iframesAndObjects,
      unsafeUrls,
      remoteStylesOrScripts,
      duplicateIdsFixed,
    },
    wordCount,
    byteSize,
  };

  return { chapter, issues };
}

function tagNeedsTextPreservation(tagName: string): boolean {
  return tagName === 'a' || tagName === 'area';
}

export function buildChapterPreviewHtml(
  sanitizedBodyHtml: string,
  images: ImageAsset[]
): string {
  if (typeof DOMParser === 'undefined') return sanitizedBodyHtml;
  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${sanitizedBodyHtml}</body></html>`,
    'text/html'
  );
  const byId = new Map(images.map((img) => [img.id, img]));

  for (const imgEl of Array.from(doc.body.querySelectorAll('img'))) {
    const assetId = imgEl.getAttribute('data-epub-image-id');
    const missingSrc = imgEl.getAttribute('data-missing-src');
    if (assetId && byId.has(assetId)) {
      const asset = byId.get(assetId)!;
      imgEl.setAttribute('src', imageToDataUri(asset.bytes, asset.mediaType));
      imgEl.removeAttribute('data-epub-image-id');
    } else if (missingSrc) {
      const placeholder = doc.createElement('div');
      placeholder.setAttribute('class', 'missing-image-box');
      placeholder.textContent = `Missing local image: ${missingSrc}`;
      imgEl.replaceWith(placeholder);
    }
  }
  return doc.body.innerHTML;
}
