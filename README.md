# ChapterBind — HTML to EPUB 3 Converter

Static, browser-based HTML to EPUB 3 converter built with **Astro**, **React**, **TypeScript**, **Tailwind CSS**, **DOMPurify**, and **fflate**.

## Local Development & Verification

```bash
npm install
npm run dev          # Local dev server (http://localhost:4321)
npm run typecheck    # Astro & TypeScript checks
npm test             # Run 11 conversion engine test scenarios (Vitest)
npm run build        # Static build to dist/
```

## Architecture

- `src/lib/epub-engine/`: Pure TypeScript conversion engine decoupled from UI:
  - `file-map.ts`: Relative path resolution, folder normalization, and duplicate image disambiguation
  - `sanitizer.ts`: Offline DOMPurify sanitization, XML NCName normalization, and heading outline extraction
  - `link-rewriter.ts`: Internal anchor and cross-chapter `.xhtml` link rewriting + broken link neutralization
  - `xhtml-serializer.ts`: Strict XML-well-formed XHTML5 serialization
  - `zip-writer.ts`: EPUB OCF ZIP builder (`mimetype` stored uncompressed first with extra field length `0`)
  - `epub-builder.ts`: `META-INF/container.xml`, `EPUB/package.opf`, `EPUB/nav.xhtml`, `EPUB/styles/ebook.css`, and cover packaging
  - `project-manager.ts`: File count/size/pixel limit enforcement and project state helpers
  - `samples.ts`: Built-in bilingual and edge-case sample books
- `src/components/ConverterApp.tsx`: Responsive 3-column desktop studio / stepped mobile UI with sandboxed `<iframe>` preview
- `src/pages/`: SEO landing page (`/`), `/how-to-convert-html-to-epub/`, `/html-to-epub-troubleshooting/`, `/privacy/`, `/about/`, `/contact/`, and `/404`

## Phase 1 Limits & Scope

- Maximum 50 files, 30 HTML chapters, 5 MB per HTML file, 10 MB / 16 MP per image, 50 MB total.
- Supports local HTML/HTM files and JPEG/PNG images (with browser canvas conversion from WebP/GIF/BMP to PNG where supported).
- Remote image URLs (`http://`, `https://`), live URL crawling, DRM removal, PDF/DOCX conversion, and server uploads are intentionally excluded.
