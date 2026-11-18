import { buildEpubZip, type ZipEntryInput } from './zip-writer';
import { rewriteBookLinks } from './link-rewriter';
import { escapeXmlAttr, escapeXmlText, serializeChapterToXhtml } from './xhtml-serializer';
import { renderTypographicCoverPng } from './image-utils';
import type {
  BookMetadata,
  BuildEpubResult,
  ChapterItem,
  ConversionIssue,
  EpubProjectState,
  ImageAsset,
} from './types';

const textEncoder = new TextEncoder();

export const DEFAULT_EPUB_CSS = `@charset "UTF-8";

html {
  font-size: 100%;
}

body {
  margin: 0;
  padding: 0.75em 0.5em;
  line-height: 1.65;
  font-family: Georgia, "Noto Serif SC", "Songti SC", serif;
  color: #18181b;
  overflow-wrap: break-word;
  word-wrap: break-word;
}

.chapter-body {
  max-width: 100%;
}

h1, h2, h3, h4, h5, h6 {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
  line-height: 1.25;
  margin-top: 1.35em;
  margin-bottom: 0.55em;
  font-weight: 700;
  page-break-after: avoid;
  break-after: avoid;
}

h1 {
  font-size: 1.65em;
  margin-top: 0.4em;
  border-bottom: 1px solid #d4d4d8;
  padding-bottom: 0.3em;
}

h2 {
  font-size: 1.3em;
}

h3 {
  font-size: 1.1em;
}

p {
  margin-top: 0;
  margin-bottom: 0.9em;
  text-align: left;
}

ul, ol {
  margin: 0.7em 0 1em 1.4em;
  padding: 0;
}

li {
  margin-bottom: 0.35em;
}

blockquote {
  margin: 1em 0;
  padding: 0.4em 0.9em;
  border-left: 3px solid #71717a;
  color: #3f3f46;
  font-style: italic;
}

pre {
  margin: 1em 0;
  padding: 0.75em 0.9em;
  background-color: #f4f4f5;
  border: 1px solid #e4e4e7;
  border-radius: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85em;
  line-height: 1.45;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
}

code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9em;
  background-color: #f4f4f5;
  padding: 0.1em 0.25em;
  border-radius: 3px;
}

pre code {
  background-color: transparent;
  padding: 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  margin: 1.1em 0;
  font-size: 0.9em;
}

th, td {
  border: 1px solid #d4d4d8;
  padding: 0.45em 0.55em;
  text-align: left;
  vertical-align: top;
}

th {
  background-color: #f4f4f5;
  font-weight: 700;
}

figure {
  margin: 1.1em 0;
  text-align: center;
}

figcaption {
  font-size: 0.85em;
  color: #52525b;
  margin-top: 0.35em;
}

img {
  max-width: 100%;
  height: auto;
  display: block;
  margin: 0.8em auto;
}

a {
  color: #0969da;
  text-decoration: underline;
}

hr {
  border: 0;
  border-top: 1px solid #d4d4d8;
  margin: 1.5em 0;
}

.missing-image-note {
  display: inline-block;
  padding: 0.35em 0.6em;
  border: 1px dashed #a1a1aa;
  color: #52525b;
  font-size: 0.85em;
  margin: 0.4em 0;
}

.cover-page {
  margin: 0;
  padding: 0;
  text-align: center;
}

.cover-image {
  max-width: 100%;
  max-height: 98vh;
  height: auto;
  margin: 0 auto;
}

nav#toc ol {
  list-style-type: none;
  margin-left: 0;
  padding-left: 0;
}

nav#toc ol ol {
  margin-left: 1.2em;
  margin-top: 0.25em;
  margin-bottom: 0.4em;
}

nav#toc li {
  margin-bottom: 0.45em;
}
`;

export function formatEpubModifiedIso(date: Date = new Date()): string {
  // EPUB 3.3 requires CCYY-MM-DDThh:mm:ssZ (UTC, no fractional seconds)
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function slugifyDownloadFilename(title: string): string {
  const clean = title
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `${clean || 'chapterbind-book'}.epub`;
}

export function buildContainerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>
`;
}

export function buildNavXhtml(params: {
  title: string;
  language: string;
  chapters: ChapterItem[];
  hasCoverPage: boolean;
  includeInBookToc: boolean;
}): string {
  const { title, language, chapters, hasCoverPage, includeInBookToc } = params;

  const chapterItems = chapters
    .map((ch) => {
      // Exclude duplicate heading matching chapter title at level 1 if it's identical, or include subheadings h2/h3
      const subHeadings = ch.headings.filter((h, idx) => {
        if (idx === 0 && h.level === 1 && h.text.trim() === ch.title.trim()) {
          return false;
        }
        return true;
      });
      const nested =
        subHeadings.length > 0
          ? `\n        <ol>\n${subHeadings
              .map(
                (h) =>
                  `          <li><a href="${escapeXmlAttr(ch.epubPath)}#${escapeXmlAttr(h.id)}">${escapeXmlText(h.text)}</a></li>`
              )
              .join('\n')}\n        </ol>`
          : '';
      return `      <li><a href="${escapeXmlAttr(ch.epubPath)}">${escapeXmlText(ch.title)}</a>${nested}</li>`;
    })
    .join('\n');

  const firstChapterHref = chapters[0]?.epubPath ?? 'nav.xhtml';
  const landmarksCover = hasCoverPage
    ? `      <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>\n`
    : '';
  const landmarksToc = includeInBookToc
    ? `      <li><a epub:type="toc" href="nav.xhtml">Table of Contents</a></li>\n`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXmlAttr(language)}" lang="${escapeXmlAttr(language)}">
<head>
  <meta charset="UTF-8" />
  <title>Table of Contents — ${escapeXmlText(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles/ebook.css" />
</head>
<body>
  <nav epub:type="toc" id="toc" role="doc-toc">
    <h1>Table of Contents</h1>
    <ol>
${chapterItems}
    </ol>
  </nav>
  <nav epub:type="landmarks" hidden="">
    <h2>Guide</h2>
    <ol>
${landmarksCover}${landmarksToc}      <li><a epub:type="bodymatter" href="${escapeXmlAttr(firstChapterHref)}">Start Reading</a></li>
    </ol>
  </nav>
</body>
</html>
`;
}

export function buildCoverXhtml(params: {
  title: string;
  language: string;
  coverHref: string;
}): string {
  const { title, language, coverHref } = params;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXmlAttr(language)}" lang="${escapeXmlAttr(language)}">
<head>
  <meta charset="UTF-8" />
  <title>Cover — ${escapeXmlText(title)}</title>
  <link rel="stylesheet" type="text/css" href="styles/ebook.css" />
</head>
<body class="cover-page">
  <section epub:type="cover">
    <img src="${escapeXmlAttr(coverHref)}" alt="${escapeXmlAttr(title)} Cover" class="cover-image" />
  </section>
</body>
</html>
`;
}

export function buildPackageOpf(params: {
  metadata: BookMetadata;
  modifiedIso: string;
  chapters: ChapterItem[];
  packagedImages: ImageAsset[];
  coverAsset: { epubPath: string; mediaType: 'image/jpeg' | 'image/png' } | null;
  hasCoverPage: boolean;
}): string {
  const { metadata, modifiedIso, chapters, packagedImages, coverAsset, hasCoverPage } = params;
  const author = metadata.author.trim() || 'Unknown Author';

  const manifestItems: string[] = [
    `    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />`,
    `    <item id="ebook-css" href="styles/ebook.css" media-type="text/css" />`,
  ];

  if (hasCoverPage && coverAsset) {
    manifestItems.push(
      `    <item id="cover-page" href="cover.xhtml" media-type="application/xhtml+xml" />`
    );
  }

  let coverAlreadyInPackaged = false;
  packagedImages.forEach((img, idx) => {
    const isCover = coverAsset && img.epubPath === coverAsset.epubPath;
    if (isCover) coverAlreadyInPackaged = true;
    const props = isCover ? ' properties="cover-image"' : '';
    manifestItems.push(
      `    <item id="img-${idx + 1}" href="${escapeXmlAttr(img.epubPath)}" media-type="${img.mediaType}"${props} />`
    );
  });

  if (coverAsset && !coverAlreadyInPackaged) {
    manifestItems.push(
      `    <item id="cover-image" href="${escapeXmlAttr(coverAsset.epubPath)}" media-type="${coverAsset.mediaType}" properties="cover-image" />`
    );
  }

  chapters.forEach((ch, idx) => {
    manifestItems.push(
      `    <item id="chap-${idx + 1}" href="${escapeXmlAttr(ch.epubPath)}" media-type="application/xhtml+xml" />`
    );
  });

  const spineItems: string[] = [];
  if (hasCoverPage && coverAsset) {
    spineItems.push(`    <itemref idref="cover-page" />`);
  }
  if (metadata.includeInBookToc) {
    spineItems.push(`    <itemref idref="nav" />`);
  }
  chapters.forEach((_, idx) => {
    spineItems.push(`    <itemref idref="chap-${idx + 1}" />`);
  });

  const descriptionTag = metadata.description.trim()
    ? `\n    <dc:description>${escapeXmlText(metadata.description.trim())}</dc:description>`
    : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="${escapeXmlAttr(metadata.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXmlText(metadata.identifier)}</dc:identifier>
    <dc:title>${escapeXmlText(metadata.title.trim())}</dc:title>
    <dc:language>${escapeXmlText(metadata.language)}</dc:language>
    <dc:creator>${escapeXmlText(author)}</dc:creator>${descriptionTag}
    <meta property="dcterms:modified">${modifiedIso}</meta>
  </metadata>
  <manifest>
${manifestItems.join('\n')}
  </manifest>
  <spine>
${spineItems.join('\n')}
  </spine>
</package>
`;
}

/**
 * Validates project preconditions, rewrites internal links in current chapter order,
 * generates strict EPUB 3.3 XHTML/OPF/Nav/CSS files, and packages a compliant ZIP archive.
 */
export async function buildEpubPackage(
  project: EpubProjectState,
  options?: { now?: Date; onProgress?: (pct: number, stepLabel: string) => void }
): Promise<BuildEpubResult> {
  const now = options?.now ?? new Date();
  const modifiedIso = formatEpubModifiedIso(now);
  const reportProgress = options?.onProgress ?? (() => {});
  const preIssues: ConversionIssue[] = [...project.issues];

  if (project.chapters.length === 0) {
    preIssues.push({
      id: 'build-no-chapters',
      severity: 'error',
      code: 'NO_CHAPTERS',
      message: 'Add at least one HTML chapter before converting to EPUB.',
    });
  }

  if (!project.metadata.title.trim()) {
    preIssues.push({
      id: 'build-no-title',
      severity: 'error',
      code: 'MISSING_BOOK_TITLE',
      message: 'Enter a Book Title before exporting your EPUB 3 file.',
    });
  }

  const blockingErrors = preIssues.filter((i) => i.severity === 'error');
  if (blockingErrors.length > 0) {
    return {
      ok: false,
      report: {
        title: project.metadata.title,
        author: project.metadata.author,
        language: project.metadata.language,
        identifier: project.metadata.identifier,
        modifiedIso,
        chapterCount: project.chapters.length,
        chapterImageCount: 0,
        packagedImageCount: 0,
        hasCover: false,
        hasGeneratedCover: false,
        totalBytes: 0,
        entryPaths: [],
        warningsCount: preIssues.filter((i) => i.severity === 'warning').length,
        errorsCount: blockingErrors.length,
        issues: preIssues,
        generatedXhtmlByChapterId: {},
      },
    };
  }

  reportProgress(15, 'Resolving cross-chapter links and anchors...');

  // Clone chapters lightly to avoid mutating caller state unexpectedly during link rewrite
  const orderedChapters: ChapterItem[] = project.chapters.map((ch, idx) => ({
    ...ch,
    epubPath: `chapters/chapter-${String(idx + 1).padStart(3, '0')}.xhtml`,
  }));

  const linkResult = rewriteBookLinks(orderedChapters);
  // Avoid duplicating BROKEN_INTERNAL_LINK issues that were already logged during import
  const basePreIssues = preIssues.filter((i) => i.code !== 'BROKEN_INTERNAL_LINK');
  const allIssues: ConversionIssue[] = [...basePreIssues, ...linkResult.issues];

  reportProgress(40, 'Generating EPUB 3 XHTML chapters...');
  const generatedXhtmlByChapterId: Record<string, string> = {};
  for (const ch of orderedChapters) {
    const rewrittenBody = linkResult.rewrittenBodiesByChapterId[ch.id] ?? ch.sanitizedBodyHtml;
    const xhtml = serializeChapterToXhtml({
      title: ch.title,
      language: project.metadata.language,
      rewrittenBodyHtml: rewrittenBody,
      images: project.images,
    });
    generatedXhtmlByChapterId[ch.id] = xhtml;
  }

  // Filter images to only those actually referenced in remaining chapters (or selected as cover)
  const referencedImageIds = new Set<string>();
  for (const ch of orderedChapters) {
    for (const ref of ch.imageRefs) {
      if (ref.matchedImageId) referencedImageIds.add(ref.matchedImageId);
    }
  }
  if (project.metadata.coverImageId) {
    referencedImageIds.add(project.metadata.coverImageId);
  }
  const packagedImages = project.images.filter((img) => referencedImageIds.has(img.id));

  reportProgress(60, 'Preparing book cover and navigation...');
  let coverAsset: { epubPath: string; mediaType: 'image/jpeg' | 'image/png'; bytes: Uint8Array } | null = null;
  let coverIsDedicatedEntry = false;

  if (project.metadata.coverImageId) {
    const selectedCover = packagedImages.find((img) => img.id === project.metadata.coverImageId);
    if (selectedCover) {
      coverAsset = {
        epubPath: selectedCover.epubPath,
        mediaType: selectedCover.mediaType,
        bytes: selectedCover.bytes,
      };
    }
  } else if (project.metadata.generateDefaultCover) {
    const generatedCoverBytes = await renderTypographicCoverPng(
      project.metadata.title,
      project.metadata.author
    );
    coverAsset = {
      epubPath: 'images/cover.png',
      mediaType: 'image/png',
      bytes: generatedCoverBytes,
    };
    coverIsDedicatedEntry = true;
  }

  const hasCoverPage = coverAsset !== null;
  const navXhtml = buildNavXhtml({
    title: project.metadata.title,
    language: project.metadata.language,
    chapters: orderedChapters,
    hasCoverPage,
    includeInBookToc: project.metadata.includeInBookToc,
  });

  const packageOpf = buildPackageOpf({
    metadata: project.metadata,
    modifiedIso,
    chapters: orderedChapters,
    packagedImages,
    coverAsset: coverAsset
      ? { epubPath: coverAsset.epubPath, mediaType: coverAsset.mediaType }
      : null,
    hasCoverPage,
  });

  reportProgress(80, 'Compressing EPUB 3 ZIP archive...');

  const zipEntries: ZipEntryInput[] = [
    {
      path: 'mimetype',
      data: textEncoder.encode('application/epub+zip'),
      storeOnly: true,
    },
    {
      path: 'META-INF/container.xml',
      data: textEncoder.encode(buildContainerXml()),
    },
    {
      path: 'EPUB/package.opf',
      data: textEncoder.encode(packageOpf),
    },
    {
      path: 'EPUB/nav.xhtml',
      data: textEncoder.encode(navXhtml),
    },
    {
      path: 'EPUB/styles/ebook.css',
      data: textEncoder.encode(DEFAULT_EPUB_CSS),
    },
  ];

  if (hasCoverPage && coverAsset) {
    zipEntries.push({
      path: 'EPUB/cover.xhtml',
      data: textEncoder.encode(
        buildCoverXhtml({
          title: project.metadata.title,
          language: project.metadata.language,
          coverHref: coverAsset.epubPath,
        })
      ),
    });
    if (coverIsDedicatedEntry) {
      zipEntries.push({
        path: `EPUB/${coverAsset.epubPath}`,
        data: coverAsset.bytes,
        storeOnly: true,
      });
    }
  }

  for (const img of packagedImages) {
    zipEntries.push({
      path: `EPUB/${img.epubPath}`,
      data: img.bytes,
      storeOnly: true,
    });
  }

  for (const ch of orderedChapters) {
    const xhtml = generatedXhtmlByChapterId[ch.id]!;
    zipEntries.push({
      path: `EPUB/${ch.epubPath}`,
      data: textEncoder.encode(xhtml),
    });
  }

  const epubBytes = buildEpubZip(zipEntries, now);
  reportProgress(100, 'EPUB 3 file ready for download.');

  return {
    ok: true,
    bytes: epubBytes,
    fileName: slugifyDownloadFilename(project.metadata.title),
    report: {
      title: project.metadata.title.trim(),
      author: project.metadata.author.trim() || 'Unknown Author',
      language: project.metadata.language,
      identifier: project.metadata.identifier,
      modifiedIso,
      chapterCount: orderedChapters.length,
      chapterImageCount: packagedImages.length,
      packagedImageCount: packagedImages.length + (coverIsDedicatedEntry ? 1 : 0),
      hasCover: hasCoverPage,
      hasGeneratedCover: coverIsDedicatedEntry,
      totalBytes: epubBytes.length,
      entryPaths: zipEntries.map((e) => e.path),
      warningsCount: allIssues.filter((i) => i.severity === 'warning').length,
      errorsCount: 0,
      issues: allIssues,
      generatedXhtmlByChapterId,
    },
  };
}
