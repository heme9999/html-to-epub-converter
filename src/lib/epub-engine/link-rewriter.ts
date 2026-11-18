import type { ChapterItem, ConversionIssue, LinkReference } from './types';
import {
  isRemoteOrExternalAssetUrl,
  resolveRelativeReference,
  safeDecodeUri,
  sanitizeRelativePath,
  stripQueryAndHash,
} from './file-map';

/**
 * Resolves and rewrites all `<a href>` attributes across chapters in their current user-defined order.
 * - External `http(s):` / `mailto:` links are preserved cleanly with `rel="noopener noreferrer"`.
 * - Same-chapter `#anchor` links map through the chapter's `idMap`.
 * - Cross-chapter links (`chapter2.html#sec`) rewrite to `chapter-002.xhtml#mapped_sec`.
 * - Unmatched local file links or missing fragment targets are neutralized into `<span>` (or fragment dropped)
 *   with a `BROKEN_INTERNAL_LINK` warning so EPUBCheck never fails on dead references.
 */
export function rewriteBookLinks(chapters: ChapterItem[]): {
  rewrittenBodiesByChapterId: Record<string, string>;
  linkRefsByChapterId: Record<string, LinkReference[]>;
  issues: ConversionIssue[];
} {
  const issues: ConversionIssue[] = [];
  const rewrittenBodiesByChapterId: Record<string, string> = {};
  const linkRefsByChapterId: Record<string, LinkReference[]> = {};

  // Build chapter lookup maps by exact normalized relative path & basename
  const bySourcePath = new Map<string, ChapterItem>();
  const bySourcePathCI = new Map<string, ChapterItem>();
  const byFileNameCI = new Map<string, ChapterItem[]>();

  chapters.forEach((ch, idx) => {
    const epubFileName = `chapter-${String(idx + 1).padStart(3, '0')}.xhtml`;
    ch.epubPath = `chapters/${epubFileName}`;
    const norm = sanitizeRelativePath(ch.sourcePath);
    bySourcePath.set(norm, ch);
    bySourcePathCI.set(norm.toLowerCase(), ch);
    const list = byFileNameCI.get(ch.fileName.toLowerCase()) ?? [];
    list.push(ch);
    byFileNameCI.set(ch.fileName.toLowerCase(), list);
  });

  for (const chapter of chapters) {
    const doc = new DOMParser().parseFromString(
      `<!DOCTYPE html><html><body>${chapter.sanitizedBodyHtml}</body></html>`,
      'text/html'
    );
    const refs: LinkReference[] = [];

    for (const anchor of Array.from(doc.body.querySelectorAll('a'))) {
      const rawHref = (anchor.getAttribute('href') ?? '').trim();
      if (!rawHref) {
        unwrapAnchorToSpan(anchor, doc);
        continue;
      }

      if (rawHref.toLowerCase().startsWith('mailto:')) {
        refs.push({
          rawHref,
          resolvedTarget: rawHref,
          kind: 'external',
        });
        continue;
      }

      if (isRemoteOrExternalAssetUrl(rawHref)) {
        anchor.setAttribute('rel', 'noopener noreferrer');
        refs.push({
          rawHref,
          resolvedTarget: rawHref,
          kind: 'external',
        });
        continue;
      }

      // Same-chapter fragment link (#section)
      if (rawHref.startsWith('#')) {
        const rawFragment = safeDecodeUri(rawHref.slice(1));
        const mappedId =
          chapter.idMap[rawFragment] ??
          chapter.idMap[rawFragment.toLowerCase()] ??
          (chapter.validIds.includes(rawFragment) ? rawFragment : undefined);

        if (mappedId) {
          anchor.setAttribute('href', `#${mappedId}`);
          refs.push({
            rawHref,
            resolvedTarget: `#${mappedId}`,
            kind: 'same-chapter-anchor',
            targetChapterId: chapter.id,
            targetAnchor: mappedId,
          });
        } else {
          issues.push({
            id: `${chapter.id}-broken-anchor-${issues.length}`,
            severity: 'warning',
            code: 'BROKEN_INTERNAL_LINK',
            message: `In "${chapter.fileName}", anchor link "${rawHref}" points to an ID not found in the cleaned chapter; converted to plain text.`,
            chapterId: chapter.id,
            sourcePath: rawHref,
          });
          refs.push({
            rawHref,
            resolvedTarget: '',
            kind: 'broken-internal',
          });
          unwrapAnchorToSpan(anchor, doc);
        }
        continue;
      }

      // Cross-chapter relative link (e.g. chapter-2.html or ../parts/part2.htm#anchor)
      const { pathPart, hashPart } = stripQueryAndHash(rawHref);
      const resolvedPath = resolveRelativeReference(chapter.sourcePath, pathPart);
      let targetChapter =
        bySourcePath.get(resolvedPath) ??
        bySourcePathCI.get(resolvedPath.toLowerCase());

      if (!targetChapter && pathPart) {
        const baseMatches = byFileNameCI.get(
          sanitizeRelativePath(safeDecodeUri(pathPart)).split('/').pop()?.toLowerCase() ?? ''
        );
        if (baseMatches && baseMatches.length === 1) {
          targetChapter = baseMatches[0];
        }
      }

      if (!targetChapter) {
        issues.push({
          id: `${chapter.id}-broken-file-link-${issues.length}`,
          severity: 'warning',
          code: 'BROKEN_INTERNAL_LINK',
          message: `In "${chapter.fileName}", internal link "${rawHref}" does not match any imported HTML chapter; converted to plain text.`,
          chapterId: chapter.id,
          sourcePath: rawHref,
        });
        refs.push({
          rawHref,
          resolvedTarget: '',
          kind: 'broken-internal',
        });
        unwrapAnchorToSpan(anchor, doc);
        continue;
      }

      // Target chapter exists; calculate relative path between chapters/chapter-XXX.xhtml files
      const targetFileName = targetChapter.epubPath.replace(/^chapters\//, '');
      let finalHref = targetFileName;
      let resolvedAnchor: string | undefined;

      if (hashPart) {
        const decodedHash = safeDecodeUri(hashPart);
        const mappedTargetId =
          targetChapter.idMap[decodedHash] ??
          targetChapter.idMap[decodedHash.toLowerCase()] ??
          (targetChapter.validIds.includes(decodedHash) ? decodedHash : undefined);
        if (mappedTargetId) {
          finalHref = `${targetFileName}#${mappedTargetId}`;
          resolvedAnchor = mappedTargetId;
        } else {
          issues.push({
            id: `${chapter.id}-broken-cross-anchor-${issues.length}`,
            severity: 'warning',
            code: 'BROKEN_INTERNAL_LINK',
            message: `In "${chapter.fileName}", link "${rawHref}" matched chapter "${targetChapter.fileName}" but anchor "#${hashPart}" was missing; linked to top of chapter instead.`,
            chapterId: chapter.id,
            sourcePath: rawHref,
          });
        }
      }

      anchor.setAttribute('href', finalHref);
      refs.push({
        rawHref,
        resolvedTarget: finalHref,
        kind: 'cross-chapter',
        targetChapterId: targetChapter.id,
        targetAnchor: resolvedAnchor,
      });
    }

    rewrittenBodiesByChapterId[chapter.id] = doc.body.innerHTML;
    linkRefsByChapterId[chapter.id] = refs;
  }

  return { rewrittenBodiesByChapterId, linkRefsByChapterId, issues };
}

function unwrapAnchorToSpan(anchor: HTMLAnchorElement, doc: Document): void {
  const span = doc.createElement('span');
  span.setAttribute('class', 'unlinked-ref');
  while (anchor.firstChild) {
    span.appendChild(anchor.firstChild);
  }
  anchor.replaceWith(span);
}
