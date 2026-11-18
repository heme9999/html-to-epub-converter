export type SupportedLanguage =
  | 'en'
  | 'zh-CN'
  | 'zh-TW'
  | 'es'
  | 'fr'
  | 'de'
  | 'ja';

export const LANGUAGE_OPTIONS: ReadonlyArray<{
  code: SupportedLanguage;
  label: string;
}> = [
  { code: 'en', label: 'English (en)' },
  { code: 'zh-CN', label: 'Chinese Simplified (zh-CN)' },
  { code: 'zh-TW', label: 'Chinese Traditional (zh-TW)' },
  { code: 'es', label: 'Spanish (es)' },
  { code: 'fr', label: 'French (fr)' },
  { code: 'de', label: 'German (de)' },
  { code: 'ja', label: 'Japanese (ja)' },
];

export interface EngineLimits {
  readonly maxFileCount: number;
  readonly maxChapterCount: number;
  readonly maxSingleHtmlBytes: number;
  readonly maxSingleImageBytes: number;
  readonly maxTotalBytes: number;
  readonly maxImagePixels: number;
}

export const DEFAULT_LIMITS: EngineLimits = {
  maxFileCount: 50,
  maxChapterCount: 30,
  maxSingleHtmlBytes: 5 * 1024 * 1024, // 5 MB
  maxSingleImageBytes: 10 * 1024 * 1024, // 10 MB
  maxTotalBytes: 50 * 1024 * 1024, // 50 MB
  maxImagePixels: 16_000_000, // 16 megapixels
};

export type IssueSeverity = 'error' | 'warning';

export type IssueCode =
  | 'LIMIT_FILE_COUNT'
  | 'LIMIT_CHAPTER_COUNT'
  | 'LIMIT_SINGLE_HTML_SIZE'
  | 'LIMIT_SINGLE_IMAGE_SIZE'
  | 'LIMIT_TOTAL_SIZE'
  | 'LIMIT_IMAGE_PIXELS'
  | 'UNSUPPORTED_FILE_TYPE'
  | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'IMAGE_CONVERTED_TO_PNG'
  | 'STRIPPED_UNSAFE_CONTENT'
  | 'REMOTE_RESOURCE_BLOCKED'
  | 'MISSING_IMAGE'
  | 'DUPLICATE_IMAGE_RENAMED'
  | 'BROKEN_INTERNAL_LINK'
  | 'MALFORMED_HTML_REPAIRED'
  | 'DUPLICATE_ID_FIXED'
  | 'EMPTY_CHAPTER_CONTENT'
  | 'NO_CHAPTERS'
  | 'MISSING_BOOK_TITLE'
  | 'EXPORT_FAILED';

export interface ConversionIssue {
  id: string;
  severity: IssueSeverity;
  code: IssueCode;
  message: string;
  chapterId?: string;
  sourcePath?: string;
  resolved?: boolean;
}

export interface RawInputFile {
  /** Clean relative path (or filename). Device absolute prefixes are stripped on import. */
  relativePath: string;
  size: number;
  mimeType?: string;
  bytes: Uint8Array;
}

export interface ImageDimensions {
  width: number;
  height: number;
  pixels: number;
}

export interface ImageAsset {
  id: string;
  /** Sanitized relative path from the imported root (never an absolute OS path). */
  sourcePath: string;
  basename: string;
  /** Internal EPUB manifest path relative to EPUB/ (e.g. images/img-01-diagram.png) */
  epubPath: string;
  mediaType: 'image/jpeg' | 'image/png';
  originalFormat: string;
  convertedFrom?: string;
  bytes: Uint8Array;
  size: number;
  dimensions: ImageDimensions | null;
  usedInChapterIds: string[];
  isCoverCandidate: boolean;
}

export interface TocHeading {
  id: string;
  text: string;
  level: 1 | 2 | 3;
}

export interface ImageReference {
  rawSrc: string;
  resolvedRelativePath: string;
  matchedImageId: string | null;
  alt: string;
}

export interface LinkReference {
  rawHref: string;
  resolvedTarget: string;
  kind: 'external' | 'same-chapter-anchor' | 'cross-chapter' | 'broken-internal' | 'unwrapped-unsafe';
  targetChapterId?: string;
  targetAnchor?: string;
}

export interface ChapterItem {
  id: string;
  /** Relative source path normalized with forward slashes */
  sourcePath: string;
  fileName: string;
  /** Output file path relative to EPUB/ (updated on reorder) */
  epubPath: string;
  title: string;
  rawHtml: string;
  /** Sanitized inner body XHTML markup (before final cross-chapter link rewriting) */
  sanitizedBodyHtml: string;
  /** Final preview HTML with in-memory data URIs for images (for isolated iframe preview only) */
  previewHtml: string;
  /** Final XHTML document string generated at build time */
  finalXhtml?: string;
  headings: TocHeading[];
  /** Map from original id attribute (lowercase/raw) -> sanitized unique XML NCName id */
  idMap: Record<string, string>;
  validIds: string[];
  imageRefs: ImageReference[];
  linkRefs: LinkReference[];
  missingImagePaths: string[];
  strippedStats: {
    scripts: number;
    eventAttributes: number;
    formsAndInputs: number;
    iframesAndObjects: number;
    unsafeUrls: number;
    remoteStylesOrScripts: number;
    duplicateIdsFixed: number;
  };
  wordCount: number;
  byteSize: number;
}

export interface BookMetadata {
  title: string;
  author: string;
  language: SupportedLanguage;
  identifier: string;
  description: string;
  coverImageId: string | null;
  generateDefaultCover: boolean;
  includeInBookToc: boolean;
}

export interface EpubProjectState {
  chapters: ChapterItem[];
  images: ImageAsset[];
  metadata: BookMetadata;
  issues: ConversionIssue[];
  totalInputBytes: number;
  importedFileCount: number;
  /** When user acknowledges missing images so export can continue with text placeholders */
  allowMissingImages: boolean;
}

export interface EpubBuildReport {
  title: string;
  author: string;
  language: SupportedLanguage;
  identifier: string;
  modifiedIso: string;
  chapterCount: number;
  chapterImageCount: number;
  packagedImageCount: number;
  hasCover: boolean;
  hasGeneratedCover: boolean;
  totalBytes: number;
  entryPaths: string[];
  warningsCount: number;
  errorsCount: number;
  issues: ConversionIssue[];
  generatedXhtmlByChapterId: Record<string, string>;
}

export interface BuildEpubResult {
  ok: boolean;
  bytes?: Uint8Array;
  fileName?: string;
  report: EpubBuildReport;
}
