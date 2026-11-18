import { encodeSolidAndBandsPng } from './image-utils';
import type { RawInputFile } from './types';

const textEncoder = new TextEncoder();

function createDiagramPng(accentRgb: [number, number, number]): Uint8Array {
  return encodeSolidAndBandsPng(640, 360, (x, y, w, h) => {
    // Border
    if (x < 4 || x >= w - 4 || y < 4 || y >= h - 4) {
      return [203, 213, 225];
    }
    // Header bar
    if (y >= 24 && y <= 64 && x >= 24 && x <= w - 24) {
      return accentRgb;
    }
    // Two side-by-side content panels
    if (y >= 90 && y <= h - 32) {
      if ((x >= 32 && x <= 296) || (x >= 344 && x <= w - 32)) {
        if (y >= 110 && y <= 134 && x >= 52 && x <= 240) {
          return [51, 65, 85];
        }
        if (y >= 152 && y <= 168 && x >= 52 && x <= 265) {
          return [148, 163, 184];
        }
        if (y >= 110 && y <= 134 && x >= 364 && x <= 540) {
          return accentRgb;
        }
        return [241, 245, 249];
      }
    }
    return [255, 255, 255];
  });
}

/**
 * Standard Sample Project:
 * - 3 HTML chapters (English + Chinese mixed text, lists, code blocks, tables, internal cross-links)
 * - 2 crisp PNG diagrams stored under `images/`
 */
export function getStandardSampleInputs(): {
  title: string;
  author: string;
  language: 'en';
  files: RawInputFile[];
} {
  const ch1Html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>1. Saving Web Articles for E-Ink Readers</title></head>
<body>
  <h1>1. Saving Web Articles for E-Ink Readers</h1>
  <p>Long-form technical essays and personal study notes read far more comfortably on an e-ink screen than in a cluttered browser tab. Converting saved HTML pages into a standard <strong>EPUB 3</strong> package turns loose folders into a portable, reflowable book.</p>
  <blockquote id="core-principle">
    <p>Reflowable ebooks let readers adjust font size, margins, and line spacing on any device without horizontal scrolling.</p>
  </blockquote>
  <figure>
    <img src="images/eink-layout.png" alt="Diagram comparing fixed desktop webpage width against reflowable EPUB layout" />
    <figcaption>Figure 1.1 — Fixed web containers vs. reflowable EPUB typography.</figcaption>
  </figure>
  <h2>Why Clean Markup Matters</h2>
  <ul>
    <li>Navigation sidebars, sticky headers, and interactive scripts belong on the web, not inside an ebook chapter.</li>
    <li>Local relative images (<code>images/eink-layout.png</code>) are bundled directly inside the ZIP container so reading works completely offline.</li>
    <li>Internal references like <a href="02-bilingual-typography.html#typography-rules">the typography rules in Chapter 2</a> are automatically rewritten to EPUB chapter paths.</li>
  </ul>
  <p>Need a quick code snippet test? Below is a minimal EPUB OPF spine block:</p>
  <pre><code>&lt;spine&gt;
  &lt;itemref idref="chap-1" /&gt;
  &lt;itemref idref="chap-2" /&gt;
&lt;/spine&gt;</code></pre>
</body>
</html>`;

  const ch2Html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>2. Reflowable Typography &amp; Bilingual Text (中英文混排)</title></head>
<body>
  <h1>2. Reflowable Typography &amp; Bilingual Text</h1>
  <p>当一篇文章同时包含中文与英文内容时（例如技术文档、读书笔记或双语对照材料），EPUB 3 必须声明完整的 UTF-8 编码与清晰的语义层级。</p>
  <h2 id="typography-rules">Core Formatting Rules (排版规范)</h2>
  <p>Good conversion strips hardcoded pixel widths while keeping headings, paragraphs, emphasis, and structured data tables intact.</p>
  <figure>
    <img src="./images/type-scale.png" alt="Diagram illustrating clean heading hierarchy and bilingual spacing" />
    <figcaption>Figure 2.1 — Clean heading hierarchy preserves navigation across devices.</figcaption>
  </figure>
  <table>
    <thead>
      <tr>
        <th scope="col">Element</th>
        <th scope="col">Web Behavior</th>
        <th scope="col">EPUB 3 Output</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td>Headings (<code>h1</code>–<code>h3</code>)</td>
        <td>Visual hierarchy</td>
        <td>Indexed into <code>nav.xhtml</code> Table of Contents</td>
      </tr>
      <tr>
        <td>Images (<code>JPEG</code> / <code>PNG</code>)</td>
        <td>Linked via relative URL</td>
        <td>Bundled under <code>EPUB/images/</code> with max-width 100%</td>
      </tr>
      <tr>
        <td>Scripts &amp; Forms</td>
        <td>Interactive DOM behavior</td>
        <td>Stripped cleanly for reader safety</td>
      </tr>
    </tbody>
  </table>
  <p>Return to <a href="01-saving-web-articles.html#core-principle">Chapter 1's core principle</a> or continue to <a href="03-offline-checklist.html">Chapter 3</a>.</p>
</body>
</html>`;

  const ch3Html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>3. Offline Reading &amp; EPUBCheck Checklist</title></head>
<body>
  <h1>3. Offline Reading &amp; EPUBCheck Checklist</h1>
  <p>Before loading a compiled ebook onto your e-reader, verify these four items:</p>
  <ol>
    <li><strong>Cover &amp; Metadata</strong>: Title, author, and primary language code match your library.</li>
    <li><strong>Chapter Sequence</strong>: Order chapters before clicking Convert so the spine and Table of Contents match.</li>
    <li><strong>Zero Dead Images</strong>: Inspect missing-resource warnings if you saved an article without its companion <code>_files</code> folder.</li>
    <li><strong>Standards Compliance</strong>: Validate output with W3C EPUBCheck and test in Apple Books, Kobo, or Calibre.</li>
  </ol>
  <p>External reference link preserved cleanly: <a href="https://www.w3.org/TR/epub-33/">W3C EPUB 3.3 Specification</a>.</p>
</body>
</html>`;

  const img1 = createDiagramPng([10, 132, 255]);
  const img2 = createDiagramPng([16, 185, 129]);

  const makeFile = (relativePath: string, bytes: Uint8Array, mimeType: string): RawInputFile => ({
    relativePath,
    size: bytes.length,
    mimeType,
    bytes,
  });

  return {
    title: 'Web Articles to Reflowable EPUB 3',
    author: 'ChapterBind Sample Edition',
    language: 'en',
    files: [
      makeFile('01-saving-web-articles.html', textEncoder.encode(ch1Html), 'text/html'),
      makeFile('02-bilingual-typography.html', textEncoder.encode(ch2Html), 'text/html'),
      makeFile('03-offline-checklist.html', textEncoder.encode(ch3Html), 'text/html'),
      makeFile('images/eink-layout.png', img1, 'image/png'),
      makeFile('images/type-scale.png', img2, 'image/png'),
    ],
  };
}

/**
 * Edge-Case Diagnostics Sample:
 * Demonstrates XSS stripping, duplicate image filenames in different folders,
 * broken internal links, malformed HTML repair, and missing image reporting.
 */
export function getEdgeCaseSampleInputs(): {
  title: string;
  author: string;
  language: 'en';
  files: RawInputFile[];
} {
  const ch1Html = `<!DOCTYPE html>
<html>
<head><title>Chapter A: Sanitizing Scripts &amp; Duplicate Filenames</title></head>
<body>
  <h1 id="dup">Chapter A: Diagnostics Demo</h1>
  <p id="dup">Unclosed paragraph repaired automatically. <span onclick="alert('xss')">Click text stripped of inline JS</span>.
  <script>window.__shouldNeverRun = true;</script>
  <iframe src="https://example.com/tracker"></iframe>
  <p><a href="javascript:alert(1)">Unsafe javascript link stripped cleanly</a> and <a href="not-uploaded.html#missing">broken internal link neutralized</a>.</p>
  <img src="part1/fig.png" alt="Part 1 diagram with shared filename fig.png" />
  <img src="images/missing-chart.png" alt="Missing diagram example" />
</body>
</html>`;

  const ch2Html = `<!DOCTYPE html>
<html>
<head><title>Chapter B: Second Folder Duplicate Image</title></head>
<body>
  <h1>Chapter B: Same Filename in Another Folder</h1>
  <p>This chapter references <code>part2/fig.png</code>, which shares its basename with Chapter A's image but sits in a separate folder.</p>
  <img src="part2/fig.png" alt="Part 2 diagram with shared filename fig.png" />
</body>
</html>`;

  const imgPart1 = createDiagramPng([249, 115, 22]);
  const imgPart2 = createDiagramPng([99, 102, 241]);

  return {
    title: 'Diagnostics & Auto-Repair Demo',
    author: 'ChapterBind QA Suite',
    language: 'en',
    files: [
      {
        relativePath: 'chapter-a.html',
        size: textEncoder.encode(ch1Html).length,
        mimeType: 'text/html',
        bytes: textEncoder.encode(ch1Html),
      },
      {
        relativePath: 'chapter-b.html',
        size: textEncoder.encode(ch2Html).length,
        mimeType: 'text/html',
        bytes: textEncoder.encode(ch2Html),
      },
      {
        relativePath: 'part1/fig.png',
        size: imgPart1.length,
        mimeType: 'image/png',
        bytes: imgPart1,
      },
      {
        relativePath: 'part2/fig.png',
        size: imgPart2.length,
        mimeType: 'image/png',
        bytes: imgPart2,
      },
    ],
  };
}
