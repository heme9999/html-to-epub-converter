import { describe, expect, it } from 'vitest';
import { unzipSync, strFromU8 } from 'fflate';
import {
  attachMissingImageFile,
  buildEpubPackage,
  clearPersistedWorkspace,
  createEmptyProject,
  deleteChapter,
  encodeSolidAndBandsPng,
  getEdgeCaseSampleInputs,
  getStandardSampleInputs,
  importRawFilesIntoProject,
  loadPersistedWorkspace,
  loadPersistedWorkspaceSync,
  renameChapter,
  reorderChapter,
  sanitizeRelativePath,
  savePersistedWorkspace,
  savePersistedWorkspaceSync,
  stripLeadingOrderNumber,
  type RawInputFile,
} from '../src/lib/epub-engine';

const encoder = new TextEncoder();

function makeHtmlFile(relativePath: string, html: string): RawInputFile {
  const bytes = encoder.encode(html);
  return {
    relativePath,
    size: bytes.length,
    mimeType: 'text/html',
    bytes,
  };
}

function makeTestPng(width = 32, height = 32, rgb: [number, number, number] = [30, 120, 210]): Uint8Array {
  return encodeSolidAndBandsPng(width, height, () => rgb);
}

describe('EPUB 3 Conversion Engine — 11 Mandatory Scenarios', () => {
  it('1. converts a single plain-text HTML chapter into a valid EPUB 3 package', async () => {
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile(
        'essay.html',
        '<html><head><title>Solo Essay</title></head><body><h1>Solo Essay</h1><p>First paragraph of clean prose.</p></body></html>'
      ),
    ]);

    expect(project.chapters).toHaveLength(1);
    expect(project.chapters[0]?.title).toBe('Solo Essay');

    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    expect(result.bytes).toBeDefined();

    const zipBytes = result.bytes!;
    // Verify ZIP first entry is uncompressed mimetype at exact offset 0
    const firstFileName = strFromU8(zipBytes.subarray(30, 38));
    expect(firstFileName).toBe('mimetype');
    const compressionMethod = zipBytes[8]! | (zipBytes[9]! << 8);
    expect(compressionMethod).toBe(0);
    const extraFieldLength = zipBytes[28]! | (zipBytes[29]! << 8);
    expect(extraFieldLength).toBe(0);
    const mimetypeContent = strFromU8(zipBytes.subarray(38, 58));
    expect(mimetypeContent).toBe('application/epub+zip');

    const entries = unzipSync(zipBytes);
    expect(Object.keys(entries)).toContain('META-INF/container.xml');
    expect(Object.keys(entries)).toContain('EPUB/package.opf');
    expect(Object.keys(entries)).toContain('EPUB/nav.xhtml');
    expect(Object.keys(entries)).toContain('EPUB/chapters/chapter-001.xhtml');
  });

  it('2. merges multiple chapters and respects reordering, renaming, and deletion in spine and TOC', async () => {
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile('c1.html', '<h1>Part One</h1><p>Alpha</p>'),
      makeHtmlFile('c2.html', '<h1>Part Two</h1><p>Beta</p>'),
      makeHtmlFile('c3.html', '<h1>Part Three</h1><p>Gamma</p>'),
    ]);

    // Move Part Three (idx 2) to index 0, rename Part One, delete Part Two
    project = reorderChapter(project, 2, 0);
    const partOneId = project.chapters[1]!.id;
    const partTwoId = project.chapters[2]!.id;
    project = renameChapter(project, partOneId, 'Renamed First Chapter');
    project = deleteChapter(project, partTwoId);

    expect(project.chapters).toHaveLength(2);
    expect(project.chapters[0]?.title).toBe('Part Three');
    expect(project.chapters[1]?.title).toBe('Renamed First Chapter');

    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    const entries = unzipSync(result.bytes!);
    const nav = strFromU8(entries['EPUB/nav.xhtml']!);
    const ch1 = strFromU8(entries['EPUB/chapters/chapter-001.xhtml']!);
    const ch2 = strFromU8(entries['EPUB/chapters/chapter-002.xhtml']!);

    expect(nav.indexOf('Part Three')).toBeLessThan(nav.indexOf('Renamed First Chapter'));
    expect(ch1).toContain('Gamma');
    expect(ch2).toContain('Alpha');
  });

  it('3. handles Chinese + English mixed text and non-Latin filenames safely', async () => {
    let project = createEmptyProject();
    const imgBytes = makeTestPng();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile(
        '随笔/第一章-中文与英文.html',
        '<html lang="zh-CN"><body><h1>双语排版 Chapter</h1><p>这是中文段落与 English inline text 的混排测试。</p><img src="插图/测试图.png" alt="Bilingual diagram" /></body></html>'
      ),
      {
        relativePath: '随笔/插图/测试图.png',
        size: imgBytes.length,
        mimeType: 'image/png',
        bytes: imgBytes,
      },
    ]);

    project.metadata.language = 'zh-CN';
    project.metadata.title = '中英文双语测试书';

    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    const entries = unzipSync(result.bytes!);
    const opf = strFromU8(entries['EPUB/package.opf']!);
    const ch1 = strFromU8(entries['EPUB/chapters/chapter-001.xhtml']!);

    expect(opf).toContain('<dc:title>中英文双语测试书</dc:title>');
    expect(opf).toContain('<dc:language>zh-CN</dc:language>');
    expect(ch1).toContain('这是中文段落与 English inline text 的混排测试。');
    expect(ch1).toMatch(/src="\.\.\/images\/img-01-[^"]+\.png"/);
  });

  it('4. resolves relative image paths across parent and sibling folders without network fetches', async () => {
    let project = createEmptyProject();
    const pngBytes = makeTestPng();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile(
        'articles/post.html',
        '<h1>Post</h1><img src="../assets/cover-chart.png" alt="Chart" /><img src="https://evil.example/tracker.png" alt="Tracker" />'
      ),
      {
        relativePath: 'assets/cover-chart.png',
        size: pngBytes.length,
        mimeType: 'image/png',
        bytes: pngBytes,
      },
    ]);

    expect(project.issues.some((i) => i.code === 'REMOTE_RESOURCE_BLOCKED')).toBe(true);
    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    expect(result.report.chapterImageCount).toBe(1);
    expect(result.report.hasGeneratedCover).toBe(true);
    expect(result.report.packagedImageCount).toBe(2); // 1 matched image + 1 generated default cover
    const entries = unzipSync(result.bytes!);
    const ch1 = strFromU8(entries['EPUB/chapters/chapter-001.xhtml']!);
    expect(ch1).toContain('img-01-cover-chart.png');
    expect(ch1).not.toContain('https://evil.example/tracker.png');
  });

  it('5. disambiguates duplicate image filenames across separate directories', async () => {
    const sample = getEdgeCaseSampleInputs();
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, sample.files);

    expect(project.images).toHaveLength(2);
    expect(project.images[0]?.epubPath).not.toBe(project.images[1]?.epubPath);
    expect(project.issues.some((i) => i.code === 'DUPLICATE_IMAGE_RENAMED')).toBe(true);

    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    const entries = unzipSync(result.bytes!);
    const ch1 = strFromU8(entries['EPUB/chapters/chapter-001.xhtml']!);
    const ch2 = strFromU8(entries['EPUB/chapters/chapter-002.xhtml']!);

    expect(ch1).toContain(project.images[0]!.epubPath);
    expect(ch2).toContain(project.images[1]!.epubPath);
  });

  it('6. rewrites valid internal cross-chapter links/anchors and neutralizes broken internal links', async () => {
    const standard = getStandardSampleInputs();
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, [
      ...standard.files,
      makeHtmlFile(
        '04-broken-links.html',
        '<h1>Links</h1><p><a href="#missing-id">Dead Local</a> <a href="does-not-exist.html">Dead File</a> <a href="https://example.org">External OK</a></p>'
      ),
    ]);

    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    expect(result.report.issues.some((i) => i.code === 'BROKEN_INTERNAL_LINK')).toBe(true);

    const entries = unzipSync(result.bytes!);
    const ch1 = strFromU8(entries['EPUB/chapters/chapter-001.xhtml']!);
    const ch4 = strFromU8(entries['EPUB/chapters/chapter-004.xhtml']!);

    expect(ch1).toContain('href="chapter-002.xhtml#typography-rules"');
    expect(ch4).toContain('href="https://example.org"');
    expect(ch4).not.toContain('href="does-not-exist.html"');
    expect(ch4).not.toContain('href="#missing-id"');
    expect(ch4).toContain('Dead Local');
    expect(ch4).toContain('Dead File');
  });

  it('7. reports missing images clearly and lets user either attach the file or export with placeholder', async () => {
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile('doc.html', '<h1>Doc</h1><img src="diagrams/missing.png" alt="Architecture" />'),
    ]);

    expect(project.issues.some((i) => i.code === 'MISSING_IMAGE')).toBe(true);
    expect(project.chapters[0]?.missingImagePaths).toEqual(['diagrams/missing.png']);

    // Export still produces valid EPUB with placeholder note when confirmed
    const resultWithoutImg = await buildEpubPackage(project);
    expect(resultWithoutImg.ok).toBe(true);
    const entriesA = unzipSync(resultWithoutImg.bytes!);
    const xhtmlA = strFromU8(entriesA['EPUB/chapters/chapter-001.xhtml']!);
    expect(xhtmlA).toContain('Missing image omitted: diagrams/missing.png');

    // Now attach missing image and confirm warning clears
    const pngBytes = makeTestPng();
    project = await attachMissingImageFile(project, 'diagrams/missing.png', {
      relativePath: 'missing.png',
      size: pngBytes.length,
      mimeType: 'image/png',
      bytes: pngBytes,
    });
    expect(project.issues.some((i) => i.code === 'MISSING_IMAGE')).toBe(false);
    const resultWithImg = await buildEpubPackage(project);
    expect(resultWithImg.ok).toBe(true);
    const entriesB = unzipSync(resultWithImg.bytes!);
    const xhtmlB = strFromU8(entriesB['EPUB/chapters/chapter-001.xhtml']!);
    expect(xhtmlB).toContain('<img src="../images/');
  });

  it('8. repairs malformed HTML and duplicate IDs into well-formed XHTML5', async () => {
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile(
        'malformed.html',
        '<h1 id="1bad">Title</h1><p id="1bad">Unclosed paragraph<span><div>Hoisted block</div></span><ul><p>Wrapped item</p></ul><a href="#sec">Outer <a href="#other">Inner</a></a>& raw ampersand'
      ),
    ]);

    expect(project.issues.some((i) => i.code === 'DUPLICATE_ID_FIXED')).toBe(true);
    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    const entries = unzipSync(result.bytes!);
    const xhtml = strFromU8(entries['EPUB/chapters/chapter-001.xhtml']!);
    expect(xhtml).toContain('&amp; raw ampersand');
    expect(xhtml).toContain('<li><p>Wrapped item</p></li>');
  });

  it('9. strips scripts, event handler attributes, forms, iframes, and javascript URLs completely', async () => {
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile(
        'xss.html',
        `<h1>Security Test</h1>
         <script>alert('xss')</script>
         <p onclick="stealCookies()" onmouseover="bad()">Safe paragraph text</p>
         <img src="x" onerror="alert(2)" />
         <form action="/login"><input type="password" /></form>
         <iframe src="https://tracker.example"></iframe>
         <a href="javascript:alert(3)">Click</a>`
      ),
    ]);

    expect(project.issues.some((i) => i.code === 'STRIPPED_UNSAFE_CONTENT')).toBe(true);
    const result = await buildEpubPackage(project);
    expect(result.ok).toBe(true);
    const entries = unzipSync(result.bytes!);
    const xhtml = strFromU8(entries['EPUB/chapters/chapter-001.xhtml']!);

    expect(xhtml).not.toContain('<script');
    expect(xhtml).not.toContain('onclick');
    expect(xhtml).not.toContain('onerror');
    expect(xhtml).not.toContain('onmouseover');
    expect(xhtml).not.toContain('<form');
    expect(xhtml).not.toContain('<input');
    expect(xhtml).not.toContain('<iframe');
    expect(xhtml).not.toContain('javascript:');
    expect(xhtml).toContain('Safe paragraph text');
  });

  it('10. enforces file count, single file size, total size, and image pixel limits with clear error codes', async () => {
    // 10a. Over single HTML size limit (custom low limit)
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(
      project,
      [makeHtmlFile('huge.html', `<p>${'a'.repeat(2048)}</p>`)],
      {
        maxFileCount: 50,
        maxChapterCount: 30,
        maxSingleHtmlBytes: 1000,
        maxSingleImageBytes: 1000,
        maxTotalBytes: 10000,
        maxImagePixels: 1000,
      }
    );
    expect(project.chapters).toHaveLength(0);
    expect(project.issues.some((i) => i.code === 'LIMIT_SINGLE_HTML_SIZE' && i.severity === 'error')).toBe(true);

    // 10b. Over image pixel limit
    const bigPng = makeTestPng(50, 50); // 2500 pixels > 1000 max
    project = await importRawFilesIntoProject(
      createEmptyProject(),
      [{ relativePath: 'big.png', size: bigPng.length, mimeType: 'image/png', bytes: bigPng }],
      {
        maxFileCount: 50,
        maxChapterCount: 30,
        maxSingleHtmlBytes: 100000,
        maxSingleImageBytes: 100000,
        maxTotalBytes: 100000,
        maxImagePixels: 1000,
      }
    );
    expect(project.images).toHaveLength(0);
    expect(project.issues.some((i) => i.code === 'LIMIT_IMAGE_PIXELS' && i.severity === 'error')).toBe(true);

    // 10c. Strips OS drive letters and leading slashes cleanly
    expect(sanitizeRelativePath('C:\\Users\\Alice\\Desktop\\book\\ch1.html')).toBe(
      'Users/Alice/Desktop/book/ch1.html'
    );
    expect(sanitizeRelativePath('/Users/bob/Documents/ch1.html')).toBe(
      'Users/bob/Documents/ch1.html'
    );
  });

  it('11. preserves user edits when export validation fails and succeeds after fixing title', async () => {
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, [
      makeHtmlFile('c1.html', '<h1>Alpha</h1><p>Text</p>'),
      makeHtmlFile('c2.html', '<h1>Beta</h1><p>More</p>'),
    ]);

    project = reorderChapter(project, 1, 0);
    project = renameChapter(project, project.chapters[0]!.id, 'Custom Beta Name');
    project.metadata.title = '   '; // Blank title causes export validation failure

    const failed = await buildEpubPackage(project);
    expect(failed.ok).toBe(false);
    expect(failed.report.issues.some((i) => i.code === 'MISSING_BOOK_TITLE')).toBe(true);
    // Chapter edits remain untouched!
    expect(project.chapters[0]?.title).toBe('Custom Beta Name');

    // Fix title and retry export cleanly
    project.metadata.title = 'Recovered Book';
    const recovered = await buildEpubPackage(project);
    expect(recovered.ok).toBe(true);
    expect(recovered.report.title).toBe('Recovered Book');
  });

  it('12. enables in-book TOC by default, strips leading order prefixes, and persists workspace across navigations', async () => {
    const empty = createEmptyProject();
    expect(empty.metadata.includeInBookToc).toBe(true);

    expect(stripLeadingOrderNumber('2. Reflowable Typography')).toBe('Reflowable Typography');
    expect(stripLeadingOrderNumber('03 - Offline Checklist')).toBe('Offline Checklist');
    expect(stripLeadingOrderNumber('Pure Chapter Name')).toBe('Pure Chapter Name');

    const sample = getStandardSampleInputs();
    let project = createEmptyProject();
    project = await importRawFilesIntoProject(project, sample.files);
    project = reorderChapter(project, 1, 0);
    project = renameChapter(project, project.chapters[0]!.id, 'Reordered Bilingual Chapter');
    project.metadata.title = 'Long Book Title That Must Persist Across Route Changes';
    project.metadata.author = 'Ada Lovelace';

    savePersistedWorkspaceSync({
      project,
      activeChapterId: project.chapters[0]!.id,
      previewTab: 'toc',
      mobileStep: 'export',
    });

    const syncLoaded = loadPersistedWorkspaceSync();
    expect(syncLoaded).not.toBeNull();
    expect(syncLoaded?.project.chapters[0]?.title).toBe('Reordered Bilingual Chapter');

    await savePersistedWorkspace({
      project,
      activeChapterId: project.chapters[0]!.id,
      previewTab: 'toc',
      mobileStep: 'export',
    });

    const loaded = await loadPersistedWorkspace();
    expect(loaded).not.toBeNull();
    expect(loaded?.project.metadata.title).toBe(
      'Long Book Title That Must Persist Across Route Changes'
    );
    expect(loaded?.project.metadata.author).toBe('Ada Lovelace');
    expect(loaded?.project.chapters[0]?.title).toBe('Reordered Bilingual Chapter');
    expect(loaded?.project.images).toHaveLength(2);
    expect(loaded?.project.images[0]?.bytes.length).toBeGreaterThan(0);
    expect(loaded?.previewTab).toBe('toc');
    expect(loaded?.mobileStep).toBe('export');

    await clearPersistedWorkspace();
    const afterClear = await loadPersistedWorkspace();
    expect(afterClear).toBeNull();
    expect(loadPersistedWorkspaceSync()).toBeNull();
  });
});
