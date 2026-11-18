import { uint8ToBase64 } from './image-utils';
import type { EpubProjectState, ImageAsset } from './types';

export type PersistedPreviewTab = 'reader' | 'toc' | 'source';
export type PersistedMobileStep = 'files' | 'preview' | 'export';

export interface PersistedWorkspacePayload {
  project: EpubProjectState;
  activeChapterId: string | null;
  previewTab: PersistedPreviewTab;
  mobileStep: PersistedMobileStep;
  savedAt: number;
}

const DB_NAME = 'chapterbind_workspace_db';
const DB_VERSION = 1;
const STORE_NAME = 'workspace';
const RECORD_KEY = 'active_project_v1';
const LS_FALLBACK_KEY = 'chapterbind_workspace_fallback_v1';

interface SerializedImageAsset extends Omit<ImageAsset, 'bytes'> {
  bytesBase64: string;
}

interface SerializedWorkspacePayload {
  project: Omit<EpubProjectState, 'images'> & {
    images: SerializedImageAsset[];
  };
  activeChapterId: string | null;
  previewTab: PersistedPreviewTab;
  mobileStep: PersistedMobileStep;
  savedAt: number;
}

function base64ToUint8(base64: string): Uint8Array {
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function serializeForStorage(payload: PersistedWorkspacePayload): SerializedWorkspacePayload {
  return {
    project: {
      ...payload.project,
      images: payload.project.images.map((img) => ({
        ...img,
        bytesBase64: uint8ToBase64(img.bytes),
      })),
    },
    activeChapterId: payload.activeChapterId,
    previewTab: payload.previewTab,
    mobileStep: payload.mobileStep,
    savedAt: payload.savedAt,
  };
}

function deserializeFromStorage(
  raw: SerializedWorkspacePayload | null | undefined
): PersistedWorkspacePayload | null {
  if (!raw || !raw.project || !Array.isArray(raw.project.chapters)) {
    return null;
  }
  const images: ImageAsset[] = (raw.project.images ?? []).map((img) => {
    const { bytesBase64, ...rest } = img;
    const bytes = bytesBase64 ? base64ToUint8(bytesBase64) : new Uint8Array(0);
    return {
      ...rest,
      bytes,
    };
  });
  return {
    project: {
      ...raw.project,
      images,
    },
    activeChapterId: raw.activeChapterId ?? null,
    previewTab: raw.previewTab ?? 'reader',
    mobileStep: raw.mobileStep ?? 'files',
    savedAt: raw.savedAt ?? Date.now(),
  };
}

function openWorkspaceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
  });
}

/**
 * Synchronously writes workspace state to localStorage so instant navigation never races async IndexedDB.
 */
export function savePersistedWorkspaceSync(
  payload: Omit<PersistedWorkspacePayload, 'savedAt'> & { savedAt?: number }
): PersistedWorkspacePayload {
  const fullPayload: PersistedWorkspacePayload = {
    project: payload.project,
    activeChapterId: payload.activeChapterId,
    previewTab: payload.previewTab,
    mobileStep: payload.mobileStep,
    savedAt: payload.savedAt ?? Date.now(),
  };
  if (typeof localStorage !== 'undefined') {
    try {
      const serialized = serializeForStorage(fullPayload);
      const json = JSON.stringify(serialized);
      if (json.length < 4_200_000) {
        localStorage.setItem(LS_FALLBACK_KEY, json);
      } else {
        localStorage.removeItem(LS_FALLBACK_KEY);
      }
    } catch {
      // Ignore quota exceeded; IndexedDB still handles large payloads asynchronously
    }
  }
  return fullPayload;
}

/**
 * Synchronously restores workspace state from localStorage on initial mount before async IndexedDB resolves.
 */
export function loadPersistedWorkspaceSync(): PersistedWorkspacePayload | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    const rawJson = localStorage.getItem(LS_FALLBACK_KEY);
    if (!rawJson) return null;
    const parsed = JSON.parse(rawJson) as SerializedWorkspacePayload;
    return deserializeFromStorage(parsed);
  } catch {
    return null;
  }
}

export async function savePersistedWorkspace(
  payload: Omit<PersistedWorkspacePayload, 'savedAt'>
): Promise<void> {
  // Always persist synchronously FIRST so rapid link clicks never race async IndexedDB opens
  const fullPayload = savePersistedWorkspaceSync(payload);
  const serialized = serializeForStorage(fullPayload);

  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openWorkspaceDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.put(serialized, RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IDB write failed'));
      });
      db.close();
    } catch {
      // localStorage already succeeded for payloads under ~4MB
    }
  }
}

export async function loadPersistedWorkspace(): Promise<PersistedWorkspacePayload | null> {
  const lsRecord = loadPersistedWorkspaceSync();
  let idbRecord: PersistedWorkspacePayload | null = null;

  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openWorkspaceDb();
      const rawRecord = await new Promise<SerializedWorkspacePayload | undefined>(
        (resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const store = tx.objectStore(STORE_NAME);
          const req = store.get(RECORD_KEY);
          req.onsuccess = () => resolve(req.result as SerializedWorkspacePayload | undefined);
          req.onerror = () => reject(req.error ?? new Error('IDB read failed'));
        }
      );
      db.close();
      idbRecord = deserializeFromStorage(rawRecord);
    } catch {
      idbRecord = null;
    }
  }

  if (lsRecord && idbRecord) {
    return lsRecord.savedAt >= idbRecord.savedAt ? lsRecord : idbRecord;
  }
  return lsRecord ?? idbRecord;
}

export async function clearPersistedWorkspace(): Promise<void> {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LS_FALLBACK_KEY);
    } catch {
      // ignore
    }
  }

  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openWorkspaceDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        store.delete(RECORD_KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error ?? new Error('IDB delete failed'));
      });
      db.close();
    } catch {
      // ignore
    }
  }
}
