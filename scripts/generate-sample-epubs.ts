import fs from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { zipSync } from 'fflate';
import {
  buildEpubPackage,
  createEmptyProject,
  getEdgeCaseSampleInputs,
  getStandardSampleInputs,
  importRawFilesIntoProject,
} from '../src/lib/epub-engine/index.ts';

// Provide DOM globals via JSDOM so the exact client-side engine runs deterministically in Node
const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  DOMParser: dom.window.DOMParser,
  Node: dom.window.Node,
  Element: dom.window.Element,
  HTMLElement: dom.window.HTMLElement,
  HTMLAnchorElement: dom.window.HTMLAnchorElement,
});

const outPublicDir = path.resolve('public/samples');
const outVerifyDir = path.resolve('/tmp/verify-epubs');
fs.mkdirSync(outPublicDir, { recursive: true });
fs.mkdirSync(outVerifyDir, { recursive: true });

async function main() {
  // 1. Standard multi-chapter sample with images, EN+ZH mixed text, internal links, cover
  const stdSample = getStandardSampleInputs();
  let stdProject = createEmptyProject();
  stdProject.metadata.title = stdSample.title;
  stdProject.metadata.author = stdSample.author;
  stdProject.metadata.language = stdSample.language;
  stdProject = await importRawFilesIntoProject(stdProject, stdSample.files);
  stdProject.metadata.title = stdSample.title;
  stdProject.metadata.author = stdSample.author;

  const stdEpub = await buildEpubPackage(stdProject, {
    now: new Date('2026-11-18T12:00:00Z'),
  });
  if (!stdEpub.ok || !stdEpub.bytes) {
    throw new Error('Failed to generate standard sample EPUB');
  }
  fs.writeFileSync(path.join(outPublicDir, 'chapterbind-sample-ebook.epub'), stdEpub.bytes);
  fs.writeFileSync(path.join(outVerifyDir, '01-standard-sample.epub'), stdEpub.bytes);

  // Also package the raw sample HTML + images as a downloadable ZIP for users
  const sourceZipMap: Record<string, Uint8Array> = {};
  for (const f of stdSample.files) {
    sourceZipMap[f.relativePath] = f.bytes;
  }
  fs.writeFileSync(
    path.join(outPublicDir, 'chapterbind-sample-source.zip'),
    zipSync(sourceZipMap)
  );

  // 2. Single-chapter plain text EPUB
  let soloProject = createEmptyProject();
  const encoder = new TextEncoder();
  const soloHtml = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Minimal Single Chapter Essay</title></head>
<body>
  <h1>Minimal Single Chapter Essay</h1>
  <p>This minimal EPUB 3 file was built from a single HTML document containing plain headings, paragraphs, emphasis, and a blockquote.</p>
  <blockquote><p>Simple inputs should yield a completely valid, clean EPUB 3 package without extra bloat.</p></blockquote>
</body>
</html>`;
  soloProject = await importRawFilesIntoProject(soloProject, [
    {
      relativePath: 'minimal-essay.html',
      size: encoder.encode(soloHtml).length,
      mimeType: 'text/html',
      bytes: encoder.encode(soloHtml),
    },
  ]);
  const soloEpub = await buildEpubPackage(soloProject, {
    now: new Date('2026-11-18T12:00:00Z'),
  });
  if (!soloEpub.ok || !soloEpub.bytes) {
    throw new Error('Failed to generate solo EPUB');
  }
  fs.writeFileSync(path.join(outVerifyDir, '02-single-chapter.epub'), soloEpub.bytes);

  // 3. Edge-case diagnostics EPUB (stripped scripts, duplicate image filenames, missing image note, repaired HTML)
  const edgeSample = getEdgeCaseSampleInputs();
  let edgeProject = createEmptyProject();
  edgeProject.metadata.title = edgeSample.title;
  edgeProject.metadata.author = edgeSample.author;
  edgeProject = await importRawFilesIntoProject(edgeProject, edgeSample.files);
  edgeProject.metadata.title = edgeSample.title;
  edgeProject.metadata.author = edgeSample.author;

  const edgeEpub = await buildEpubPackage(edgeProject, {
    now: new Date('2026-11-18T12:00:00Z'),
  });
  if (!edgeEpub.ok || !edgeEpub.bytes) {
    throw new Error('Failed to generate edge-case EPUB');
  }
  fs.writeFileSync(path.join(outVerifyDir, '03-edge-cases.epub'), edgeEpub.bytes);

  console.log('Generated sample EPUBs:', {
    standardBytes: stdEpub.bytes.length,
    soloBytes: soloEpub.bytes.length,
    edgeBytes: edgeEpub.bytes.length,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
