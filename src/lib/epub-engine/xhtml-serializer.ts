import type { ImageAsset } from './types';

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

/**
 * Strips characters disallowed in XML 1.0 (e.g. NUL or C0 control chars except \t, \n, \r).
 */
export function stripInvalidXmlChars(input: string): string {
  return input.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
}

export function escapeXmlText(input: string): string {
  return stripInvalidXmlChars(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function escapeXmlAttr(input: string): string {
  return escapeXmlText(input)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const VALID_XHTML_ATTRS = new Set([
  'id',
  'class',
  'href',
  'src',
  'alt',
  'title',
  'colspan',
  'rowspan',
  'scope',
  'lang',
  'xml:lang',
  'dir',
  'rel',
  'epub:type',
]);

function serializeElementToXhtml(el: Element, imageById: Map<string, ImageAsset>): string {
  const tag = el.tagName.toLowerCase();

  // Handle matched / missing images before serializing attributes
  if (tag === 'img') {
    const assetId = el.getAttribute('data-epub-image-id');
    const missingSrc = el.getAttribute('data-missing-src');
    if (missingSrc && !assetId) {
      return `<span class="missing-image-note">[Missing image omitted: ${escapeXmlText(missingSrc)}]</span>`;
    }
    const asset = assetId ? imageById.get(assetId) : undefined;
    if (!asset) {
      const alt = el.getAttribute('alt') ?? 'Image';
      return `<span class="missing-image-note">[Image unavailable: ${escapeXmlText(alt)}]</span>`;
    }
    // Chapter XHTML files live in EPUB/chapters/, images live in EPUB/images/
    const relativeImgSrc = `../${asset.epubPath}`;
    const altAttr = escapeXmlAttr(el.getAttribute('alt') || asset.basename);
    const title = el.getAttribute('title');
    const idAttr = el.getAttribute('id');
    let attrs = ` src="${escapeXmlAttr(relativeImgSrc)}" alt="${altAttr}"`;
    if (title) attrs += ` title="${escapeXmlAttr(title)}"`;
    if (idAttr) attrs += ` id="${escapeXmlAttr(idAttr)}"`;
    return `<img${attrs} />`;
  }

  let attrStr = '';
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    if (!VALID_XHTML_ATTRS.has(name)) continue;
    // Note: EPUB 3 XHTML expects `xml:lang` alongside or instead of `lang`
    if (name === 'lang') {
      attrStr += ` lang="${escapeXmlAttr(attr.value)}" xml:lang="${escapeXmlAttr(attr.value)}"`;
      continue;
    }
    if (name === 'xml:lang' && el.hasAttribute('lang')) continue;
    attrStr += ` ${name}="${escapeXmlAttr(attr.value)}"`;
  }

  if (VOID_ELEMENTS.has(tag)) {
    return `<${tag}${attrStr} />`;
  }

  let inner = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      inner += escapeXmlText(child.textContent ?? '');
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      inner += serializeElementToXhtml(child as Element, imageById);
    }
  }

  // Ensure non-empty valid structure for <a> or <td> if needed; normal tags close cleanly
  return `<${tag}${attrStr}>${inner}</${tag}>`;
}

/**
 * Serializes a chapter's rewritten HTML body into a complete, valid EPUB 3.3 XHTML5 document.
 */
export function serializeChapterToXhtml(params: {
  title: string;
  language: string;
  rewrittenBodyHtml: string;
  images: ImageAsset[];
  cssRelativeHref?: string;
}): string {
  const {
    title,
    language,
    rewrittenBodyHtml,
    images,
    cssRelativeHref = '../styles/ebook.css',
  } = params;

  const doc = new DOMParser().parseFromString(
    `<!DOCTYPE html><html><body>${rewrittenBodyHtml}</body></html>`,
    'text/html'
  );
  const imageById = new Map(images.map((img) => [img.id, img]));

  let serializedBodyContent = '';
  for (const node of Array.from(doc.body.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      const txt = (node.textContent ?? '').trim();
      if (txt) {
        serializedBodyContent += `<p>${escapeXmlText(txt)}</p>\n`;
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      serializedBodyContent += `${serializeElementToXhtml(node as Element, imageById)}\n`;
    }
  }

  if (!serializedBodyContent.trim()) {
    serializedBodyContent = `<p>${escapeXmlText(title)}</p>\n`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXmlAttr(language)}" lang="${escapeXmlAttr(language)}">
<head>
  <meta charset="UTF-8" />
  <title>${escapeXmlText(title)}</title>
  <link rel="stylesheet" type="text/css" href="${escapeXmlAttr(cssRelativeHref)}" />
</head>
<body>
  <section epub:type="chapter" class="chapter-body">
${serializedBodyContent.trimEnd()}
  </section>
</body>
</html>
`;
}
