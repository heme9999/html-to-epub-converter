import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  attachMissingImageFile,
  buildEpubPackage,
  clearPersistedWorkspace,
  createEmptyProject,
  DEFAULT_LIMITS,
  deleteChapter,
  fileListToRawInputs,
  getEdgeCaseSampleInputs,
  getStandardSampleInputs,
  imageToDataUri,
  importRawFilesIntoProject,
  LANGUAGE_OPTIONS,
  loadPersistedWorkspace,
  renameChapter,
  reorderChapter,
  rewriteBookLinks,
  savePersistedWorkspace,
  serializeChapterToXhtml,
  stripLeadingOrderNumber,
  type BuildEpubResult,
  type ConversionIssue,
  type EpubProjectState,
  type SupportedLanguage,
} from '@/lib/epub-engine';

type PreviewTab = 'reader' | 'toc' | 'source';
type MobileStep = 'files' | 'preview' | 'export';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function escapePreviewHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildIsolatedPreviewSrcDoc(params: {
  title: string;
  bodyHtml: string;
  fontStyle: 'serif' | 'sans';
  widthMode: 'eink' | 'tablet';
}): string {
  const { title, bodyHtml, fontStyle, widthMode } = params;
  const fontFamily =
    fontStyle === 'serif'
      ? 'Georgia, "Noto Serif SC", "Songti SC", serif'
      : '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
  const maxWidth = widthMode === 'eink' ? '34rem' : '48rem';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src 'unsafe-inline';" />
<title>${escapePreviewHtml(title)}</title>
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fcfcfa;
    color: #1c1917;
    font-family: ${fontFamily};
    line-height: 1.68;
    font-size: 16px;
    overflow-wrap: break-word;
  }
  main {
    max-width: ${maxWidth};
    margin: 0 auto;
    padding: 1.5rem 1.4rem 2.5rem;
  }
  h1, h2, h3, h4 {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif;
    line-height: 1.25;
    margin-top: 1.3em;
    margin-bottom: 0.55em;
    color: #111827;
  }
  h1 { font-size: 1.55em; margin-top: 0.2em; border-bottom: 1px solid #e5e7eb; padding-bottom: 0.3em; }
  h2 { font-size: 1.25em; }
  h3 { font-size: 1.08em; }
  p { margin: 0 0 0.9em; }
  ul, ol { margin: 0.6em 0 1em 1.4em; padding: 0; }
  li { margin-bottom: 0.35em; }
  blockquote {
    margin: 1em 0;
    padding: 0.45em 0.9em;
    border-left: 3px solid #9ca3af;
    color: #4b5563;
    font-style: italic;
    background: #f9fafb;
  }
  pre {
    background: #f3f4f6;
    border: 1px solid #e5e7eb;
    border-radius: 6px;
    padding: 0.75em;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.85em;
    white-space: pre-wrap;
    word-break: break-word;
  }
  code {
    background: #f3f4f6;
    padding: 0.1em 0.3em;
    border-radius: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em;
  }
  pre code { background: transparent; padding: 0; }
  table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: 0.9em; }
  th, td { border: 1px solid #d1d5db; padding: 0.45em 0.6em; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; }
  img { max-width: 100%; height: auto; display: block; margin: 0.9em auto; border-radius: 4px; }
  figure { margin: 1em 0; text-align: center; }
  figcaption { font-size: 0.85em; color: #6b7280; margin-top: 0.35em; }
  a { color: #0a84ff; text-decoration: underline; }
  .missing-image-box {
    border: 1px dashed #d97706;
    background: #fffbeb;
    color: #92400e;
    padding: 0.65rem 0.85rem;
    border-radius: 6px;
    font-family: -apple-system, sans-serif;
    font-size: 0.85rem;
    margin: 0.75rem 0;
  }
  .unlinked-ref {
    border-bottom: 1px dotted #9ca3af;
    color: #4b5563;
  }
</style>
</head>
<body>
  <main>${bodyHtml}</main>
</body>
</html>`;
}

export default function ConverterApp() {
  const [project, setProject] = useState<EpubProjectState>(() => createEmptyProject());
  const [activeChapterId, setActiveChapterId] = useState<string | null>(null);
  const [previewTab, setPreviewTab] = useState<PreviewTab>('reader');
  const [mobileStep, setMobileStep] = useState<MobileStep>('files');
  const [readerWidth, setReaderWidth] = useState<'eink' | 'tablet'>('eink');
  const [readerFont, setReaderFont] = useState<'serif' | 'sans'>('serif');

  const [isImporting, setIsImporting] = useState(false);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [hasHydratedStorage, setHasHydratedStorage] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<number | null>(null);
  const exportSectionRef = useRef<HTMLDivElement | null>(null);

  // Form validation & export state
  const [titleTouched, setTitleTouched] = useState(false);
  const [titleError, setTitleError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const [convertProgress, setConvertProgress] = useState(0);
  const [convertStatusText, setConvertStatusText] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<BuildEpubResult | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [announceText, setAnnounceText] = useState('');

  // Missing image quick-attach target
  const [attachTargetSrc, setAttachTargetSrc] = useState<string | null>(null);
  const missingAttachInputRef = useRef<HTMLInputElement | null>(null);
  const filesInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const coverInputRef = useRef<HTMLInputElement | null>(null);
  const titleInputRef = useRef<HTMLInputElement | null>(null);

  // Pointer drag-and-drop reorder state for chapters (modern-web-guidance: drag-and-drop)
  const chapterListRef = useRef<HTMLUListElement | null>(null);
  const dragStateRef = useRef<{
    pointerId: number;
    chapterId: string;
    fromIndex: number;
    targetIndex: number;
    startY: number;
    itemEl: HTMLLIElement;
    handleEl: HTMLElement;
    startScrollTop: number;
    lastClientY: number;
  } | null>(null);
  const [draggingChapterId, setDraggingChapterId] = useState<string | null>(null);

  const titleInputId = useId();
  const titleErrorId = useId();
  const authorInputId = useId();
  const langSelectId = useId();

  // Hydrate persisted workspace across page navigation or refresh
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const saved = await loadPersistedWorkspace();
        if (!active) return;
        if (saved && saved.project.chapters.length > 0) {
          setProject(saved.project);
          setActiveChapterId(saved.activeChapterId ?? saved.project.chapters[0]?.id ?? null);
          setPreviewTab(saved.previewTab ?? 'reader');
          setMobileStep(saved.mobileStep ?? 'files');
          setDraftSavedAt(saved.savedAt);
        }
      } finally {
        if (active) setHasHydratedStorage(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // Auto-save workspace changes to IndexedDB/localStorage so switching to guides never loses edits
  useEffect(() => {
    if (!hasHydratedStorage) return;
    if (project.chapters.length === 0 && project.images.length === 0) {
      return;
    }
    const timer = setTimeout(() => {
      void savePersistedWorkspace({
        project,
        activeChapterId,
        previewTab,
        mobileStep,
      }).then(() => setDraftSavedAt(Date.now()));
    }, 120);
    return () => clearTimeout(timer);
  }, [hasHydratedStorage, project, activeChapterId, previewTab, mobileStep]);

  // Flush persistence synchronously/immediately before navigating away
  useEffect(() => {
    if (!hasHydratedStorage || project.chapters.length === 0) return;
    const flush = () => {
      void savePersistedWorkspace({
        project,
        activeChapterId,
        previewTab,
        mobileStep,
      });
    };
    window.addEventListener('pagehide', flush);
    return () => window.removeEventListener('pagehide', flush);
  }, [hasHydratedStorage, project, activeChapterId, previewTab, mobileStep]);

  // Revoke previous Blob URL whenever exportResult changes
  useEffect(() => {
    return () => {
      if (downloadUrl) {
        URL.revokeObjectURL(downloadUrl);
      }
    };
  }, [downloadUrl]);

  // Keep activeChapterId synced with existing chapters
  useEffect(() => {
    if (project.chapters.length === 0) {
      setActiveChapterId(null);
      return;
    }
    if (!activeChapterId || !project.chapters.some((c) => c.id === activeChapterId)) {
      setActiveChapterId(project.chapters[0]!.id);
    }
  }, [project.chapters, activeChapterId]);

  const activeChapter = useMemo(
    () => project.chapters.find((c) => c.id === activeChapterId) ?? project.chapters[0] ?? null,
    [project.chapters, activeChapterId]
  );

  const activeChapterIndex = useMemo(
    () => (activeChapter ? project.chapters.findIndex((c) => c.id === activeChapter.id) : -1),
    [project.chapters, activeChapter]
  );

  // Derived error & warning breakdown
  const blockingErrors = useMemo(
    () => project.issues.filter((i) => i.severity === 'error'),
    [project.issues]
  );
  const warnings = useMemo(
    () => project.issues.filter((i) => i.severity === 'warning'),
    [project.issues]
  );
  const missingImageIssues = useMemo(
    () => warnings.filter((i) => i.code === 'MISSING_IMAGE'),
    [warnings]
  );
  const uniqueMissingPaths = useMemo(() => {
    const set = new Set<string>();
    for (const issue of missingImageIssues) {
      if (issue.sourcePath) set.add(issue.sourcePath);
    }
    return Array.from(set);
  }, [missingImageIssues]);

  const isolatedPreviewSrcDoc = useMemo(() => {
    if (!activeChapter) return '';
    return buildIsolatedPreviewSrcDoc({
      title: activeChapter.title,
      bodyHtml: activeChapter.previewHtml,
      fontStyle: readerFont,
      widthMode: readerWidth,
    });
  }, [activeChapter, readerFont, readerWidth]);

  // Live XHTML preview for the selected chapter
  const activeChapterXhtmlPreview = useMemo(() => {
    if (!activeChapter) return '';
    const linkResult = rewriteBookLinks(
      project.chapters.map((c, idx) => ({
        ...c,
        epubPath: `chapters/chapter-${String(idx + 1).padStart(3, '0')}.xhtml`,
      }))
    );
    const body = linkResult.rewrittenBodiesByChapterId[activeChapter.id] ?? activeChapter.sanitizedBodyHtml;
    return serializeChapterToXhtml({
      title: activeChapter.title,
      language: project.metadata.language,
      rewrittenBodyHtml: body,
      images: project.images,
    });
  }, [activeChapter, project.chapters, project.images, project.metadata.language]);

  const matchedImagesCount = useMemo(
    () => project.images.filter((img) => img.usedInChapterIds.length > 0).length,
    [project.images]
  );

  const selectedCoverAsset = useMemo(
    () => project.images.find((i) => i.id === project.metadata.coverImageId) ?? null,
    [project.images, project.metadata.coverImageId]
  );

  const clearExportOutput = useCallback(() => {
    setExportResult(null);
    setExportError(null);
    setDownloadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const handleImportFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!fileList || fileList.length === 0) return;
      setIsImporting(true);
      clearExportOutput();
      try {
        const rawInputs = await fileListToRawInputs(fileList);
        const nextState = await importRawFilesIntoProject(project, rawInputs, DEFAULT_LIMITS);
        setProject(nextState);
        if (nextState.chapters.length > 0 && !activeChapterId) {
          setActiveChapterId(nextState.chapters[0]!.id);
        }
        setTitleError(null);
        setAnnounceText(
          `Imported ${rawInputs.length} file(s). Project now has ${nextState.chapters.length} chapter(s) and ${nextState.images.length} image(s).`
        );
      } catch (err) {
        setExportError(err instanceof Error ? err.message : 'Failed to read selected files.');
      } finally {
        setIsImporting(false);
      }
    },
    [project, activeChapterId, clearExportOutput]
  );

  const handleLoadSample = useCallback(
    async (kind: 'standard' | 'edge') => {
      setIsImporting(true);
      clearExportOutput();
      try {
        const sample =
          kind === 'standard' ? getStandardSampleInputs() : getEdgeCaseSampleInputs();
        const fresh = createEmptyProject();
        fresh.metadata.title = sample.title;
        fresh.metadata.author = sample.author;
        fresh.metadata.language = sample.language;
        const imported = await importRawFilesIntoProject(fresh, sample.files, DEFAULT_LIMITS);
        imported.metadata.title = sample.title;
        imported.metadata.author = sample.author;
        setProject(imported);
        setActiveChapterId(imported.chapters[0]?.id ?? null);
        setTitleError(null);
        setTitleTouched(false);
        setPreviewTab('reader');
        setAnnounceText(
          `Loaded ${kind === 'standard' ? 'Standard Sample Book' : 'Edge-Case Diagnostics Demo'} with ${imported.chapters.length} chapters.`
        );
      } finally {
        setIsImporting(false);
      }
    },
    [clearExportOutput]
  );

  const handleResetProject = useCallback(() => {
    clearExportOutput();
    void clearPersistedWorkspace();
    setDraftSavedAt(null);
    setProject(createEmptyProject());
    setActiveChapterId(null);
    setTitleError(null);
    setTitleTouched(false);
    setConvertProgress(0);
    setConvertStatusText('');
    setAnnounceText('Project cleared. Ready for new HTML files.');
  }, [clearExportOutput]);

  const moveChapterByOffset = useCallback(
    (index: number, delta: -1 | 1) => {
      const target = index + delta;
      if (target < 0 || target >= project.chapters.length) return;
      const movedTitle = project.chapters[index]?.title ?? 'Chapter';
      clearExportOutput();
      setProject((prev) => reorderChapter(prev, index, target));
      setAnnounceText(`Moved "${movedTitle}" to position ${target + 1}.`);
    },
    [project.chapters, clearExportOutput]
  );

  const handleRenameChapter = useCallback(
    (chapterId: string, newTitle: string) => {
      clearExportOutput();
      setProject((prev) => renameChapter(prev, chapterId, newTitle));
    },
    [clearExportOutput]
  );

  const handleDeleteChapter = useCallback(
    (chapterId: string) => {
      const ch = project.chapters.find((c) => c.id === chapterId);
      clearExportOutput();
      setProject((prev) => deleteChapter(prev, chapterId));
      if (ch) {
        setAnnounceText(`Removed chapter "${ch.title}".`);
      }
    },
    [project.chapters, clearExportOutput]
  );

  const handleUploadCustomCover = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      const raw = await fileListToRawInputs(files);
      const first = raw[0];
      if (!first) return;
      clearExportOutput();
      const next = await importRawFilesIntoProject(project, [first], DEFAULT_LIMITS);
      const uploadedCover = next.images[next.images.length - 1];
      if (uploadedCover) {
        next.metadata = {
          ...next.metadata,
          coverImageId: uploadedCover.id,
          generateDefaultCover: false,
        };
      }
      setProject(next);
    },
    [project, clearExportOutput]
  );

  const handleAttachMissingImage = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0 || !attachTargetSrc) return;
      const raw = await fileListToRawInputs(files);
      const file = raw[0];
      if (!file) return;
      clearExportOutput();
      const next = await attachMissingImageFile(project, attachTargetSrc, file);
      setProject(next);
      setAnnounceText(`Attached "${file.relativePath}" to missing path "${attachTargetSrc}".`);
      setAttachTargetSrc(null);
    },
    [attachTargetSrc, project, clearExportOutput]
  );

  const validateBookTitle = useCallback((value: string): string | null => {
    if (!value.trim()) {
      return 'Enter a book title for the EPUB metadata and cover.';
    }
    return null;
  }, []);

  const runConversion = useCallback(
    async (e?: React.SyntheticEvent<HTMLFormElement>) => {
      if (e) e.preventDefault();
      setTitleTouched(true);
      const tErr = validateBookTitle(project.metadata.title);
      setTitleError(tErr);
      if (tErr) {
        titleInputRef.current?.focus();
        setExportError('Fix the required Book Title field before converting.');
        return;
      }
      if (project.chapters.length === 0) {
        setExportError('Add at least one HTML chapter or load the Sample Book first.');
        return;
      }
      if (blockingErrors.length > 0) {
        setExportError(
          `Resolve ${blockingErrors.length} blocking file error(s) in the diagnostics panel before converting.`
        );
        return;
      }

      setIsConverting(true);
      setExportError(null);
      setConvertProgress(8);
      setConvertStatusText('Preparing chapters and verifying assets...');

      try {
        // Yield briefly so UI renders indeterminate/progress transition cleanly
        await new Promise((r) => setTimeout(r, 30));

        const result = await buildEpubPackage(project, {
          onProgress: (pct, stepLabel) => {
            setConvertProgress(pct);
            setConvertStatusText(stepLabel);
          },
        });

        if (!result.ok || !result.bytes) {
          setExportError(
            result.report.issues.find((i) => i.severity === 'error')?.message ??
              'Conversion did not produce a valid EPUB package. Your chapters and edits are preserved.'
          );
          return;
        }

        const copy = new Uint8Array(result.bytes.byteLength);
        copy.set(result.bytes);
        const blob = new Blob([copy], { type: 'application/epub+zip' });
        const url = URL.createObjectURL(blob);

        setDownloadUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setExportResult(result);
        setConvertStatusText(
          `EPUB 3 ready (${formatBytes(result.report.totalBytes)}, ${result.report.chapterCount} chapter(s)).`
        );
        setAnnounceText(`EPUB 3 conversion completed: ${result.fileName}`);
        setTimeout(() => {
          exportSectionRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }, 60);
      } catch (err) {
        setExportError(
          err instanceof Error
            ? `Export failed safely (your edits are preserved): ${err.message}`
            : 'Unexpected export failure. Your edits remain intact.'
        );
      } finally {
        setIsConverting(false);
      }
    },
    [project, blockingErrors.length, validateBookTitle]
  );

  // Pointer-capture drag-and-drop reordering for chapters (modern-web-guidance: drag-and-drop)
  const updateDropMarkerForPointer = useCallback((clientY: number) => {
    const state = dragStateRef.current;
    const listEl = chapterListRef.current;
    if (!state || !listEl) return;

    const listRect = listEl.getBoundingClientRect();
    const clampedY = Math.max(listRect.top, Math.min(clientY, listRect.bottom));
    const items = Array.from(listEl.children).filter(
      (n): n is HTMLLIElement => n.tagName === 'LI'
    );

    let insertIdx = items.length;
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i]!;
      const rect = item.getBoundingClientRect();
      const midY = rect.top + rect.height / 2;
      if (clampedY < midY) {
        insertIdx = i;
        break;
      }
    }

    // Target index after removing fromIndex
    let targetIndex = insertIdx > state.fromIndex ? insertIdx - 1 : insertIdx;
    targetIndex = Math.max(0, Math.min(items.length - 1, targetIndex));
    state.targetIndex = targetIndex;

    // Position CSS drop marker unless dropping in exact same slot
    if (targetIndex === state.fromIndex) {
      listEl.removeAttribute('data-drop');
    } else {
      listEl.setAttribute('data-drop', 'true');
      let markerY = listRect.top;
      if (insertIdx === 0 && items[0]) {
        markerY = items[0].getBoundingClientRect().top - 2;
      } else if (insertIdx >= items.length && items[items.length - 1]) {
        markerY = items[items.length - 1]!.getBoundingClientRect().bottom + 2;
      } else if (items[insertIdx - 1] && items[insertIdx]) {
        const prevRect = items[insertIdx - 1]!.getBoundingClientRect();
        const nextRect = items[insertIdx]!.getBoundingClientRect();
        markerY = (prevRect.bottom + nextRect.top) / 2;
      }
      listEl.style.setProperty('--drop-x', `${listRect.left + 8}px`);
      listEl.style.setProperty('--drop-y', `${markerY}px`);
      listEl.style.setProperty('--drop-w', `${Math.max(80, listRect.width - 16)}px`);
    }

    // Lift dragged element to follow pointer
    const deltaY = clientY - state.startY + (listEl.scrollTop - state.startScrollTop);
    state.itemEl.style.transform = `translate3d(0, ${deltaY}px, 0) scale(1.015)`;
    state.itemEl.style.zIndex = '40';
    state.itemEl.style.position = 'relative';
    state.itemEl.style.boxShadow = '0 10px 24px rgba(0, 0, 0, 0.14)';
  }, []);

  const cleanupDrag = useCallback((commit: boolean) => {
    const state = dragStateRef.current;
    const listEl = chapterListRef.current;
    if (!state || !listEl) return;

    state.itemEl.style.transform = '';
    state.itemEl.style.zIndex = '';
    state.itemEl.style.position = '';
    state.itemEl.style.boxShadow = '';
    listEl.removeAttribute('data-drop');
    listEl.classList.remove('chapter-list-dragging');
    listEl.style.removeProperty('--drop-x');
    listEl.style.removeProperty('--drop-y');
    listEl.style.removeProperty('--drop-w');

    if (state.handleEl.hasPointerCapture?.(state.pointerId)) {
      try {
        state.handleEl.releasePointerCapture(state.pointerId);
      } catch {
        // ignore if already released
      }
    }

    const { fromIndex, targetIndex, chapterId } = state;
    dragStateRef.current = null;
    setDraggingChapterId(null);

    if (commit && fromIndex !== targetIndex) {
      clearExportOutput();
      setProject((prev) => reorderChapter(prev, fromIndex, targetIndex));
      const ch = project.chapters.find((c) => c.id === chapterId);
      if (ch) {
        setAnnounceText(`Moved "${ch.title}" to position ${targetIndex + 1}.`);
      }
    }
  }, [clearExportOutput, project.chapters]);

  useEffect(() => {
    const onPointerMove = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || e.pointerId !== state.pointerId) return;
      state.lastClientY = e.clientY;
      updateDropMarkerForPointer(e.clientY);
    };
    const onPointerUp = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || e.pointerId !== state.pointerId) return;
      cleanupDrag(true);
    };
    const onPointerCancel = (e: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state || e.pointerId !== state.pointerId) return;
      cleanupDrag(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && dragStateRef.current) {
        cleanupDrag(false);
        setAnnounceText('Chapter reorder cancelled.');
      }
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('pointercancel', onPointerCancel);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', onPointerCancel);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [cleanupDrag, updateDropMarkerForPointer]);

  const startHandleDrag = (
    e: React.PointerEvent<HTMLButtonElement>,
    chapterId: string,
    index: number
  ) => {
    if (e.button !== 0 || project.chapters.length < 2) return;
    const itemEl = e.currentTarget.closest('li');
    const listEl = chapterListRef.current;
    if (!itemEl || !listEl) return;

    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // fallback safely if unsupported
    }

    dragStateRef.current = {
      pointerId: e.pointerId,
      chapterId,
      fromIndex: index,
      targetIndex: index,
      startY: e.clientY,
      lastClientY: e.clientY,
      itemEl,
      handleEl: e.currentTarget,
      startScrollTop: listEl.scrollTop,
    };
    setDraggingChapterId(chapterId);
    listEl.classList.add('chapter-list-dragging');
    updateDropMarkerForPointer(e.clientY);
  };

  // Global file dropzone handlers
  const handleFileDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingFiles(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      await handleImportFiles(e.dataTransfer.files);
    }
  };

  return (
    <section
      id="converter-workspace"
      aria-label="HTML to EPUB Converter Workspace"
      className="mx-auto max-w-7xl scroll-mt-28 px-4 pb-10 sm:scroll-mt-20 sm:px-6"
    >
      {/* Hidden native file pickers (excluded from accessibility tree so browser-locale Chinese text is not exposed) */}
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".html,.htm,.xhtml,.jpg,.jpeg,.png,.webp,.gif,.bmp,.svg"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleImportFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        hidden
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(e) => {
          if (e.target.files) void handleImportFiles(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={coverInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.gif,.bmp"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(e) => {
          void handleUploadCustomCover(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={missingAttachInputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp,.gif,.bmp"
        hidden
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(e) => {
          void handleAttachMissingImage(e.target.files);
          e.target.value = '';
        }}
      />

      {/* Screen-reader live region */}
      <div className="sr-only" aria-live="polite" role="status">
        {announceText}
      </div>

      {/* Top Toolbar & Sample Quick-Start */}
      <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-xs sm:p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => filesInputRef.current?.click()}
              disabled={isImporting}
              className="btn-tactile inline-flex min-h-[42px] items-center gap-2 rounded-xl bg-[#0a84ff] px-4 py-2 text-sm font-semibold text-white shadow-xs hover:bg-[#0070e0] disabled:opacity-60"
            >
              <span>Add HTML &amp; Images</span>
            </button>

            <button
              type="button"
              onClick={() => folderInputRef.current?.click()}
              disabled={isImporting}
              className="btn-tactile inline-flex min-h-[42px] items-center gap-2 rounded-xl border border-black/15 bg-white px-3.5 py-2 text-sm font-semibold text-[#1d1d1f] hover:bg-black/[0.04] disabled:opacity-60"
            >
              <span>Select Folder</span>
            </button>

            <button
              type="button"
              onClick={() => void handleLoadSample('standard')}
              disabled={isImporting}
              className="btn-tactile inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-[#0a84ff]/30 bg-[#0a84ff]/[0.08] px-3.5 py-2 text-sm font-semibold text-[#005bb5] hover:bg-[#0a84ff]/15 disabled:opacity-60"
            >
              <span>Try Sample Book</span>
            </button>

            <button
              type="button"
              onClick={() => void handleLoadSample('edge')}
              disabled={isImporting}
              className="btn-tactile inline-flex min-h-[42px] items-center gap-1.5 rounded-xl border border-black/10 bg-[#f5f5f7] px-3 py-2 text-xs font-semibold text-[#515154] hover:bg-black/[0.07] disabled:opacity-60"
            >
              <span>Diagnostics Demo</span>
            </button>

            {project.chapters.length > 0 && (
              <button
                type="button"
                onClick={handleResetProject}
                className="btn-tactile inline-flex min-h-[42px] items-center rounded-xl px-3 py-2 text-xs font-semibold text-[#b91c1c] hover:bg-red-50"
              >
                Clear All
              </button>
            )}
          </div>

          {/* Live Import Telemetry Pills */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="rounded-lg bg-[#f5f5f7] px-2.5 py-1 font-semibold text-[#1d1d1f]">
              {project.chapters.length}/{DEFAULT_LIMITS.maxChapterCount} Chapters
            </span>
            <span className="rounded-lg bg-[#f5f5f7] px-2.5 py-1 font-semibold text-[#1d1d1f]">
              {matchedImagesCount} Matched Image{matchedImagesCount === 1 ? '' : 's'}
            </span>
            <span className="rounded-lg bg-[#f5f5f7] px-2.5 py-1 font-medium text-[#515154]">
              {formatBytes(project.totalInputBytes)} / 50 MB
            </span>
            {blockingErrors.length > 0 && (
              <span className="rounded-lg bg-red-100 px-2.5 py-1 font-semibold text-red-800">
                {blockingErrors.length} Error{blockingErrors.length === 1 ? '' : 's'}
              </span>
            )}
            {warnings.length > 0 && (
              <span className="rounded-lg bg-amber-100 px-2.5 py-1 font-semibold text-amber-900">
                {warnings.length} Warning{warnings.length === 1 ? '' : 's'}
              </span>
            )}
            {project.chapters.length > 0 && draftSavedAt && (
              <span className="rounded-lg bg-emerald-100/80 px-2.5 py-1 font-medium text-emerald-900">
                Draft saved in browser
              </span>
            )}
          </div>
        </div>

        {/* Empty State Dropzone (Above the fold when no chapters loaded) */}
        {project.chapters.length === 0 && (
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setIsDraggingFiles(true);
            }}
            onDragLeave={() => setIsDraggingFiles(false)}
            onDrop={(e) => void handleFileDrop(e)}
            className={`mt-4 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed px-6 py-10 text-center transition-colors ${
              isDraggingFiles
                ? 'border-[#0a84ff] bg-[#0a84ff]/[0.06]'
                : 'border-black/15 bg-[#f5f5f7]/60'
            }`}
          >
            <div className="mx-auto max-w-xl space-y-3">
              <div className="text-base font-bold text-[#1d1d1f] sm:text-lg">
                Drop HTML files, saved webpage folders, and local images here
              </div>
              <p className="text-sm leading-relaxed text-[#515154]">
                Combine one or multiple <code>.html</code> / <code>.htm</code> files with relative{' '}
                <code>JPEG</code> / <code>PNG</code> images. Files are parsed, sanitized, and zipped
                inside your browser with zero account sign-up.
              </p>
              <div className="flex flex-wrap justify-center gap-2 pt-1 text-xs text-[#6e6e73]">
                <span>Max 50 files</span>
                <span>·</span>
                <span>Max 30 chapters</span>
                <span>·</span>
                <span>5 MB per HTML</span>
                <span>·</span>
                <span>10 MB / 16 MP per image</span>
                <span>·</span>
                <span>50 MB total</span>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mobile Step Tabs (< lg) */}
      {project.chapters.length > 0 && (
        <div className="mt-4 lg:hidden">
          <div
            role="tablist"
            aria-label="Mobile converter steps"
            className="flex flex-nowrap overflow-x-auto border-b border-black/10 bg-white rounded-t-xl px-2"
          >
            {(
              [
                { id: 'files', label: `1. Files (${project.chapters.length})` },
                { id: 'preview', label: '2. Preview & TOC' },
                {
                  id: 'export',
                  label:
                    blockingErrors.length > 0
                      ? `3. Export (${blockingErrors.length} err)`
                      : '3. Export',
                },
              ] as const
            ).map((step) => (
              <button
                key={step.id}
                type="button"
                role="tab"
                aria-selected={mobileStep === step.id}
                onClick={() => setMobileStep(step.id)}
                className="px-3 py-3 text-xs font-semibold whitespace-nowrap text-[#515154]"
              >
                {step.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Main 3-Column Studio Workspace */}
      {project.chapters.length > 0 && (
        <div className="mt-4 grid grid-cols-1 gap-4 pb-4 lg:grid-cols-[315px_minmax(0,1fr)_335px] lg:items-start lg:pb-0">
          {/* LEFT COLUMN: Chapters & Assets */}
          <section
            aria-label="Chapters and Local Images"
            className={`rounded-2xl border border-black/10 bg-white p-4 shadow-xs ${
              mobileStep !== 'files' ? 'hidden lg:block' : 'block'
            }`}
          >
            <div className="flex items-center justify-between gap-2 border-b border-black/8 pb-3">
              <h2 className="text-sm font-bold text-[#1d1d1f]">
                Chapters ({project.chapters.length})
              </h2>
              <button
                type="button"
                onClick={() => filesInputRef.current?.click()}
                className="text-xs font-semibold text-[#0a84ff] hover:underline"
              >
                + Add files
              </button>
            </div>

            {/* Compact secondary dropzone */}
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setIsDraggingFiles(true);
              }}
              onDragLeave={() => setIsDraggingFiles(false)}
              onDrop={(e) => void handleFileDrop(e)}
              className={`mt-3 rounded-xl border border-dashed px-3 py-2.5 text-center text-xs transition-colors ${
                isDraggingFiles
                  ? 'border-[#0a84ff] bg-[#0a84ff]/10 text-[#005bb5]'
                  : 'border-black/15 bg-[#f5f5f7]/70 text-[#515154]'
              }`}
            >
              Drop more HTML chapters or missing images here
            </div>

            {/* Reorderable Chapter List */}
            <ul
              ref={chapterListRef}
              className="chapter-list mt-3 max-h-[430px] space-y-2 overflow-y-auto pr-0.5"
              aria-label="Chapter order list"
            >
              {project.chapters.map((chapter, idx) => {
                const isSelected = activeChapter?.id === chapter.id;
                const isDragged = draggingChapterId === chapter.id;
                const hasMissing = chapter.missingImagePaths.length > 0;
                return (
                  <li
                    key={chapter.id}
                    className={`chapter-item-card rounded-xl border p-2.5 transition-colors ${
                      isSelected
                        ? 'border-[#0a84ff] bg-[#0a84ff]/[0.05]'
                        : 'border-black/10 bg-[#fafafa] hover:bg-[#f5f5f7]'
                    } ${isDragged ? 'opacity-95' : ''}`}
                  >
                    <div className="chapter-row-grid">
                      {/* Dedicated drag handle */}
                      <button
                        type="button"
                        onPointerDown={(e) => startHandleDrag(e, chapter.id, idx)}
                        aria-label={`Drag to reorder ${chapter.title}`}
                        title="Drag to reorder chapter"
                        className="chapter-drag-handle inline-flex h-8 w-7 items-center justify-center rounded-lg text-[#6e6e73] hover:bg-black/[0.06] hover:text-[#1d1d1f]"
                      >
                        <span aria-hidden="true" className="text-sm leading-none">
                          ⋮⋮
                        </span>
                      </button>

                      {/* Shrinkable title & filename */}
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="inline-flex h-5 min-w-[20px] shrink-0 items-center justify-center rounded bg-black/[0.07] px-1 text-[11px] font-bold text-[#1d1d1f]">
                            {idx + 1}
                          </span>
                          <input
                            type="text"
                            value={chapter.title}
                            aria-label={`Chapter ${idx + 1} title`}
                            onFocus={() => setActiveChapterId(chapter.id)}
                            onChange={(e) => handleRenameChapter(chapter.id, e.target.value)}
                            className="w-full min-w-0 rounded-md border border-transparent bg-transparent px-1.5 py-0.5 text-xs font-semibold text-[#1d1d1f] focus:border-[#0a84ff] focus:bg-white focus:outline-none"
                          />
                        </div>

                        <button
                          type="button"
                          onClick={() => {
                            setActiveChapterId(chapter.id);
                            setMobileStep('preview');
                          }}
                          className="mt-1 flex w-full items-center justify-between gap-2 text-left text-[11px] text-[#6e6e73] hover:text-[#1d1d1f]"
                        >
                          <span className="truncate" title={chapter.sourcePath}>
                            {chapter.sourcePath}
                          </span>
                          <span className="shrink-0">
                            {chapter.wordCount}w
                            {hasMissing ? ' · !img' : ''}
                          </span>
                        </button>
                      </div>

                      {/* Explicit Move Up / Down & Delete (essential on mobile & keyboard) */}
                      <div className="flex items-center gap-0.5">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveChapterByOffset(idx, -1)}
                          aria-label={`Move ${chapter.title} up`}
                          title="Move up"
                          className="btn-tactile inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-[#515154] hover:bg-black/[0.06] disabled:opacity-30"
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          disabled={idx === project.chapters.length - 1}
                          onClick={() => moveChapterByOffset(idx, 1)}
                          aria-label={`Move ${chapter.title} down`}
                          title="Move down"
                          className="btn-tactile inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-[#515154] hover:bg-black/[0.06] disabled:opacity-30"
                        >
                          ↓
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDeleteChapter(chapter.id)}
                          aria-label={`Delete chapter ${chapter.title}`}
                          title="Delete chapter"
                          className="btn-tactile inline-flex h-7 w-7 items-center justify-center rounded-lg text-xs font-bold text-[#b91c1c] hover:bg-red-50"
                        >
                          ×
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>

            {/* Imported Image Assets List */}
            <div className="mt-4 border-t border-black/8 pt-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-bold tracking-wide text-[#515154] uppercase">
                  Local Images ({project.images.length})
                </h3>
                <span className="text-[11px] text-[#6e6e73]">JPEG / PNG</span>
              </div>
              {project.images.length === 0 ? (
                <p className="mt-2 text-xs text-[#6e6e73]">
                  No local images imported yet. Add image files or select the companion folder alongside your HTML.
                </p>
              ) : (
                <ul className="mt-2 max-h-40 space-y-1.5 overflow-y-auto text-xs">
                  {project.images.map((img) => (
                    <li
                      key={img.id}
                      className="flex items-center justify-between gap-2 rounded-lg bg-[#f5f5f7] px-2.5 py-1.5"
                    >
                      <span className="min-w-0 truncate font-medium text-[#1d1d1f]" title={img.sourcePath}>
                        {img.sourcePath}
                      </span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ${
                          img.usedInChapterIds.length > 0
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-black/[0.06] text-[#515154]'
                        }`}
                      >
                        {img.usedInChapterIds.length > 0
                          ? `Used (${img.usedInChapterIds.length})`
                          : 'Unlinked'}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          {/* CENTER COLUMN: Isolated Reader Preview & TOC */}
          <section
            aria-label="Chapter Preview and Table of Contents"
            className={`rounded-2xl border border-black/10 bg-white shadow-xs ${
              mobileStep !== 'preview' ? 'hidden lg:block' : 'block'
            }`}
          >
            {/* Preview Tablist */}
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-black/10 px-4">
              <div role="tablist" aria-label="Preview view modes" className="flex flex-nowrap overflow-x-auto">
                {(
                  [
                    { id: 'reader', label: 'Reader Preview' },
                    { id: 'toc', label: 'Table of Contents' },
                    { id: 'source', label: 'XHTML Output' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.id}
                    id={`preview-tab-${tab.id}`}
                    type="button"
                    role="tab"
                    aria-selected={previewTab === tab.id}
                    onClick={() => setPreviewTab(tab.id)}
                    className="px-3 py-3 text-xs font-semibold whitespace-nowrap text-[#515154] hover:text-[#1d1d1f] sm:text-sm"
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              {previewTab === 'reader' && (
                <div className="flex items-center gap-1.5 py-2">
                  <button
                    type="button"
                    onClick={() => setReaderWidth((w) => (w === 'eink' ? 'tablet' : 'eink'))}
                    className="rounded-lg border border-black/10 bg-[#f5f5f7] px-2 py-1 text-[11px] font-semibold text-[#515154] hover:text-[#1d1d1f]"
                  >
                    {readerWidth === 'eink' ? '6" E-Ink' : 'Tablet'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setReaderFont((f) => (f === 'serif' ? 'sans' : 'serif'))}
                    className="rounded-lg border border-black/10 bg-[#f5f5f7] px-2 py-1 text-[11px] font-semibold text-[#515154] hover:text-[#1d1d1f]"
                  >
                    {readerFont === 'serif' ? 'Serif' : 'Sans'}
                  </button>
                </div>
              )}
            </div>

            {/* Reader Preview Panel (Isolated Sandboxed Iframe) */}
            <div
              role="tabpanel"
              aria-labelledby="preview-tab-reader"
              hidden={previewTab !== 'reader'}
            >
              <div className="p-4">
                {activeChapter ? (
                  <>
                    <div className="mb-3 flex items-center justify-between gap-2 text-xs text-[#515154]">
                      <span className="truncate font-semibold text-[#1d1d1f]">
                        Chapter {activeChapterIndex + 1} of {project.chapters.length}: {activeChapter.title}
                      </span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          disabled={activeChapterIndex <= 0}
                          onClick={() => {
                            const prev = project.chapters[activeChapterIndex - 1];
                            if (prev) setActiveChapterId(prev.id);
                          }}
                          className="rounded-lg border border-black/10 px-2 py-1 text-xs font-semibold hover:bg-[#f5f5f7] disabled:opacity-40"
                        >
                          Prev
                        </button>
                        <button
                          type="button"
                          disabled={activeChapterIndex >= project.chapters.length - 1}
                          onClick={() => {
                            const next = project.chapters[activeChapterIndex + 1];
                            if (next) setActiveChapterId(next.id);
                          }}
                          className="rounded-lg border border-black/10 px-2 py-1 text-xs font-semibold hover:bg-[#f5f5f7] disabled:opacity-40"
                        >
                          Next
                        </button>
                      </div>
                    </div>

                    <div className="overflow-hidden rounded-xl border border-black/10 bg-[#fcfcfa]">
                      <iframe
                        sandbox=""
                        title={`Sanitized preview of ${activeChapter.title}`}
                        srcDoc={isolatedPreviewSrcDoc}
                        className="h-[500px] w-full border-0"
                      />
                    </div>
                    <p className="mt-2 text-[11px] text-[#6e6e73]">
                      Isolated preview runs inside a script-disabled sandboxed frame (
                      <code>sandbox=&quot;&quot;</code>) using reflowable EPUB typography rather than original site CSS.
                    </p>
                  </>
                ) : null}
              </div>
            </div>

            {/* Table of Contents Panel */}
            <div
              role="tabpanel"
              aria-labelledby="preview-tab-toc"
              hidden={previewTab !== 'toc'}
            >
              <div className="p-5">
                <div className="mb-3 flex items-center justify-between">
                  <h3 className="text-sm font-bold text-[#1d1d1f]">
                    Generated Table of Contents (<code>nav.xhtml</code>)
                  </h3>
                  <span className="text-xs text-[#6e6e73]">
                    {project.chapters.length} spine item{project.chapters.length === 1 ? '' : 's'}
                  </span>
                </div>
                <ol className="space-y-2.5 text-sm">
                  {project.chapters.map((ch, idx) => {
                    const subHeadings = ch.headings.filter((h, hIdx) => {
                      if (hIdx === 0 && h.level === 1 && h.text.trim() === ch.title.trim()) {
                        return false;
                      }
                      return true;
                    });
                    return (
                      <li key={ch.id} className="rounded-xl border border-black/8 bg-[#fafafa] p-3">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveChapterId(ch.id);
                            setPreviewTab('reader');
                          }}
                          className="flex w-full items-center justify-between gap-2 text-left font-semibold text-[#0a84ff] hover:underline"
                        >
                          <span>
                            {idx + 1}. {stripLeadingOrderNumber(ch.title)}
                          </span>
                          <span className="shrink-0 font-mono text-[11px] text-[#6e6e73]">
                            chapter-{String(idx + 1).padStart(3, '0')}.xhtml
                          </span>
                        </button>
                        {subHeadings.length > 0 && (
                          <ol className="mt-2 space-y-1 border-l-2 border-black/10 pl-3 text-xs text-[#515154]">
                            {subHeadings.map((h) => (
                              <li key={h.id} className={h.level === 3 ? 'pl-3' : ''}>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setActiveChapterId(ch.id);
                                    setPreviewTab('reader');
                                  }}
                                  className="text-left hover:text-[#1d1d1f] hover:underline"
                                >
                                  {h.text}
                                </button>
                              </li>
                            ))}
                          </ol>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </div>
            </div>

            {/* XHTML Output Source Panel */}
            <div
              role="tabpanel"
              aria-labelledby="preview-tab-source"
              hidden={previewTab !== 'source'}
            >
              <div className="p-4">
                <div className="mb-2 flex items-center justify-between text-xs text-[#515154]">
                  <span>
                    Serialized EPUB 3.3 XHTML for{' '}
                    <strong className="text-[#1d1d1f]">{activeChapter?.epubPath}</strong>
                  </span>
                  <span>UTF-8 · XML well-formed</span>
                </div>
                <pre className="max-h-[500px] overflow-auto rounded-xl border border-black/10 bg-[#14171f] p-3.5 font-mono text-[11px] leading-relaxed text-slate-100">
                  <code>{activeChapterXhtmlPreview}</code>
                </pre>
              </div>
            </div>
          </section>

          {/* RIGHT COLUMN: Metadata Form, Diagnostics & Export */}
          <section
            aria-label="Book Settings, Diagnostics and EPUB Export"
            className={`space-y-4 ${mobileStep !== 'export' ? 'hidden lg:block' : 'block'}`}
          >
            {/* Metadata & Cover Form */}
            <form
              noValidate
              onSubmit={(e) => void runConversion(e)}
              className="rounded-2xl border border-black/10 bg-white p-4 shadow-xs"
            >
              <fieldset className="space-y-3.5 border-0 p-0">
                <legend className="text-sm font-bold text-[#1d1d1f]">Book Metadata &amp; Cover</legend>

                <div className="space-y-1">
                  <label htmlFor={titleInputId} className="block text-xs font-semibold text-[#1d1d1f]">
                    Book Title <span aria-hidden="true" className="text-red-600">*</span>
                  </label>
                  <input
                    ref={titleInputRef}
                    id={titleInputId}
                    name="bookTitle"
                    type="text"
                    required
                    value={project.metadata.title}
                    aria-invalid={titleError ? 'true' : undefined}
                    aria-describedby={titleError ? titleErrorId : undefined}
                    onBlur={() => {
                      setTitleTouched(true);
                      setTitleError(validateBookTitle(project.metadata.title));
                    }}
                    onChange={(e) => {
                      const val = e.target.value;
                      clearExportOutput();
                      setProject((prev) => ({
                        ...prev,
                        metadata: { ...prev.metadata, title: val },
                      }));
                      if (titleTouched) {
                        setTitleError(validateBookTitle(val));
                      }
                    }}
                    placeholder="e.g. Collected Essays on Typography"
                    className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm text-[#1d1d1f] focus:border-[#0a84ff] focus:outline-none"
                  />
                  {titleError && (
                    <p id={titleErrorId} className="text-xs font-medium text-red-700">
                      {titleError}
                    </p>
                  )}
                </div>

                <div className="space-y-1">
                  <label htmlFor={authorInputId} className="block text-xs font-semibold text-[#1d1d1f]">
                    Author
                  </label>
                  <input
                    id={authorInputId}
                    name="bookAuthor"
                    type="text"
                    value={project.metadata.author}
                    onChange={(e) => {
                      clearExportOutput();
                      setProject((prev) => ({
                        ...prev,
                        metadata: { ...prev.metadata, author: e.target.value },
                      }));
                    }}
                    placeholder="Unknown Author"
                    className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm text-[#1d1d1f] focus:border-[#0a84ff] focus:outline-none"
                  />
                </div>

                <div className="space-y-1">
                  <label htmlFor={langSelectId} className="block text-xs font-semibold text-[#1d1d1f]">
                    Primary Language
                  </label>
                  <select
                    id={langSelectId}
                    name="bookLanguage"
                    value={project.metadata.language}
                    onChange={(e) => {
                      clearExportOutput();
                      setProject((prev) => ({
                        ...prev,
                        metadata: {
                          ...prev.metadata,
                          language: e.target.value as SupportedLanguage,
                        },
                      }));
                    }}
                    className="w-full rounded-xl border border-black/15 bg-white px-3 py-2 text-sm text-[#1d1d1f] focus:border-[#0a84ff] focus:outline-none"
                  >
                    {LANGUAGE_OPTIONS.map((opt) => (
                      <option key={opt.code} value={opt.code}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>

                {/* Cover selector & live preview */}
                <div className="rounded-xl border border-black/10 bg-[#f5f5f7]/80 p-3">
                  <div className="flex items-start gap-3">
                    {selectedCoverAsset ? (
                      <img
                        src={imageToDataUri(selectedCoverAsset.bytes, selectedCoverAsset.mediaType)}
                        alt="Selected book cover preview"
                        className="h-32 w-24 shrink-0 rounded-md border border-black/10 object-cover shadow-xs"
                      />
                    ) : project.metadata.generateDefaultCover ? (
                      <div
                        aria-hidden="true"
                        className="flex min-h-[8.5rem] w-24 shrink-0 flex-col justify-between gap-1.5 rounded-md border border-black/15 bg-[#14171f] p-2.5 text-[9px] leading-tight text-white shadow-xs"
                      >
                        <span className="font-semibold tracking-wide text-[#60a5fa]">EPUB 3</span>
                        <span className="break-words text-[9.5px] leading-snug font-bold">
                          {project.metadata.title || 'Untitled'}
                        </span>
                        <span className="break-words text-[8px] leading-tight text-slate-300">
                          {project.metadata.author || 'Author'}
                        </span>
                      </div>
                    ) : (
                      <div className="flex min-h-[8.5rem] w-24 shrink-0 items-center justify-center rounded-md border border-dashed border-black/20 bg-white text-[10px] text-[#6e6e73]">
                        No Cover
                      </div>
                    )}

                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="text-xs font-semibold text-[#1d1d1f]">Book Cover</div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => coverInputRef.current?.click()}
                          className="rounded-lg border border-black/15 bg-white px-2.5 py-1 text-[11px] font-semibold text-[#1d1d1f] hover:bg-black/[0.04]"
                        >
                          Upload JPEG/PNG
                        </button>
                        {project.metadata.coverImageId && (
                          <button
                            type="button"
                            onClick={() => {
                              clearExportOutput();
                              setProject((prev) => ({
                                ...prev,
                                metadata: {
                                  ...prev.metadata,
                                  coverImageId: null,
                                  generateDefaultCover: true,
                                },
                              }));
                            }}
                            className="rounded-lg border border-black/10 bg-white px-2 py-1 text-[11px] font-medium text-[#515154]"
                          >
                            Use Auto Cover
                          </button>
                        )}
                      </div>
                      <label className="flex items-center gap-1.5 text-[11px] text-[#515154]">
                        <input
                          type="checkbox"
                          checked={project.metadata.generateDefaultCover && !project.metadata.coverImageId}
                          onChange={(e) => {
                            clearExportOutput();
                            setProject((prev) => ({
                              ...prev,
                              metadata: {
                                ...prev.metadata,
                                coverImageId: e.target.checked ? null : prev.metadata.coverImageId,
                                generateDefaultCover: e.target.checked,
                              },
                            }));
                          }}
                          className="accent-[#0a84ff]"
                        />
                        Auto-generate typographic cover
                      </label>
                    </div>
                  </div>
                </div>

                <label className="flex items-center gap-2 text-xs text-[#515154]">
                  <input
                    type="checkbox"
                    checked={project.metadata.includeInBookToc}
                    onChange={(e) => {
                      clearExportOutput();
                      setProject((prev) => ({
                        ...prev,
                        metadata: { ...prev.metadata, includeInBookToc: e.target.checked },
                      }));
                    }}
                    className="accent-[#0a84ff]"
                  />
                  Include Table of Contents page inside reading spine
                </label>

                {/* Primary Convert Button */}
                <div className="pt-1">
                  <button
                    type="submit"
                    disabled={isConverting || isImporting}
                    className="btn-tactile flex min-h-[46px] w-full items-center justify-center rounded-xl bg-[#0a84ff] px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-[#0070e0] disabled:opacity-60"
                  >
                    {isConverting ? 'Building EPUB 3...' : 'Convert to EPUB'}
                  </button>
                </div>

                {(isConverting || convertProgress > 0) && (
                  <div className="space-y-1.5 pt-1">
                    <progress
                      className="epub-progress"
                      max={100}
                      value={convertProgress}
                      aria-label="EPUB conversion progress"
                    />
                    <p role="status" className="text-[11px] font-medium text-[#515154]">
                      {convertStatusText}
                    </p>
                  </div>
                )}
              </fieldset>
            </form>

            {/* Recoverable Export Error Banner */}
            {exportError && (
              <div
                role="alert"
                className="rounded-2xl border border-red-300 bg-red-50 p-4 text-xs text-red-900 shadow-xs"
              >
                <div className="font-bold">Export paused — your edits are safe</div>
                <p className="mt-1 leading-relaxed">{exportError}</p>
                <button
                  type="button"
                  onClick={() => void runConversion()}
                  className="mt-2.5 rounded-lg bg-red-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-red-800"
                >
                  Retry Export
                </button>
              </div>
            )}

            {/* Successful Download & Report Card */}
            {exportResult?.ok && downloadUrl && (
              <div
                ref={exportSectionRef}
                className="scroll-mt-28 rounded-2xl border border-emerald-300 bg-emerald-50/90 p-4 shadow-xs"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-bold text-emerald-950">EPUB 3 Ready</div>
                    <p className="mt-0.5 text-xs text-emerald-900">
                      {exportResult.fileName} · {formatBytes(exportResult.report.totalBytes)}
                    </p>
                  </div>
                  <span className="rounded-full bg-emerald-200/80 px-2 py-0.5 text-[10px] font-bold text-emerald-950">
                    EPUB 3.0
                  </span>
                </div>

                <a
                  href={downloadUrl}
                  download={exportResult.fileName}
                  className="btn-tactile mt-3 flex min-h-[44px] w-full items-center justify-center rounded-xl bg-emerald-700 px-4 py-2 text-sm font-bold text-white shadow-xs hover:bg-emerald-800"
                >
                  Download EPUB File
                </a>

                <dl className="mt-3 grid grid-cols-2 gap-2 border-t border-emerald-200 pt-3 text-[11px] text-emerald-950">
                  <div>
                    <dt className="text-emerald-800">Spine Chapters</dt>
                    <dd className="font-bold">{exportResult.report.chapterCount}</dd>
                  </div>
                  <div>
                    <dt className="text-emerald-800">Packaged Images</dt>
                    <dd className="font-bold">{exportResult.report.packagedImageCount}</dd>
                  </div>
                  <div>
                    <dt className="text-emerald-800">Cover Included</dt>
                    <dd className="font-bold">{exportResult.report.hasCover ? 'Yes' : 'No'}</dd>
                  </div>
                  <div>
                    <dt className="text-emerald-800">Non-blocking Warnings</dt>
                    <dd className="font-bold">{exportResult.report.warningsCount}</dd>
                  </div>
                </dl>
              </div>
            )}

            {/* Issues & Warnings Diagnostics Panel */}
            <div className="rounded-2xl border border-black/10 bg-white p-4 shadow-xs">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-[#1d1d1f]">Diagnostics &amp; Issues</h3>
                <span className="text-[11px] text-[#6e6e73]">
                  {blockingErrors.length} err · {warnings.length} warn
                </span>
              </div>

              {project.issues.length === 0 ? (
                <p className="mt-2 text-xs text-emerald-800">
                  No missing images, unsafe tags, or limit warnings detected.
                </p>
              ) : (
                <div className="mt-3 space-y-2.5">
                  {/* Missing image quick fixers */}
                  {uniqueMissingPaths.length > 0 && (
                    <div className="rounded-xl border border-amber-300 bg-amber-50 p-3">
                      <div className="text-xs font-bold text-amber-950">
                        Missing Local Image Paths ({uniqueMissingPaths.length})
                      </div>
                      <p className="mt-1 text-[11px] text-amber-900">
                        Attach each file below or export anyway to replace missing images with readable placeholders.
                      </p>
                      <ul className="mt-2 space-y-1.5">
                        {uniqueMissingPaths.map((path) => (
                          <li
                            key={path}
                            className="flex items-center justify-between gap-2 rounded-lg bg-white/80 px-2.5 py-1.5 text-[11px]"
                          >
                            <code className="min-w-0 truncate text-amber-950" title={path}>
                              {path}
                            </code>
                            <button
                              type="button"
                              onClick={() => {
                                setAttachTargetSrc(path);
                                missingAttachInputRef.current?.click();
                              }}
                              className="shrink-0 rounded-md bg-amber-800 px-2 py-1 text-[10px] font-semibold text-white hover:bg-amber-900"
                            >
                              Attach file
                            </button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Full issue log distinguishing Errors vs Warnings */}
                  <ul className="max-h-60 space-y-1.5 overflow-y-auto text-xs">
                    {project.issues.map((issue: ConversionIssue) => (
                      <li
                        key={issue.id}
                        className={`rounded-xl border px-3 py-2 ${
                          issue.severity === 'error'
                            ? 'border-red-200 bg-red-50 text-red-900'
                            : 'border-amber-200 bg-amber-50/70 text-amber-950'
                        }`}
                      >
                        <div className="flex items-center gap-1.5 font-semibold">
                          <span
                            className={`rounded px-1.5 py-0.5 text-[10px] uppercase ${
                              issue.severity === 'error'
                                ? 'bg-red-200 text-red-900'
                                : 'bg-amber-200 text-amber-950'
                            }`}
                          >
                            {issue.severity}
                          </span>
                          <span className="truncate font-mono text-[10px] opacity-80">
                            {issue.code}
                          </span>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed">{issue.message}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </section>
        </div>
      )}

      {/* Mobile Sticky Action Bar (< lg): sticky within workspace so it never covers content below or scrolled end-of-panel cards */}
      {project.chapters.length > 0 && (
        <div className="glass-bar sticky bottom-0 z-30 -mx-4 mt-4 border-t border-black/10 px-4 pt-2.5 pb-[calc(0.65rem+env(safe-area-inset-bottom,0px))] shadow-[0_-4px_16px_rgba(0,0,0,0.06)] lg:hidden">
          <div className="mx-auto flex max-w-xl items-center justify-between gap-3">
            <div className="min-w-0 text-xs">
              <div className="truncate font-bold text-[#1d1d1f]">
                {project.metadata.title || 'Untitled Book'}
              </div>
              <div className="text-[11px] text-[#515154]">
                {project.chapters.length} ch · {warnings.length} warn
              </div>
            </div>
            <button
              type="button"
              disabled={isConverting}
              onClick={() => {
                setMobileStep('export');
                void runConversion();
              }}
              className="btn-tactile shrink-0 rounded-xl bg-[#0a84ff] px-4 py-2 text-xs font-bold text-white shadow-xs hover:bg-[#0070e0]"
            >
              {isConverting ? 'Building...' : 'Convert to EPUB'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
