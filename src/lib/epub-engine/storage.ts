import { imageToDataUri, uint8ToBase64 } from './image-utils';
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
  // Ensure previewHtml still has usable data URIs (or kept intact)
  void imageToDataUri;
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

export async function savePersistedWorkspace(
  payload: Omit<PersistedWorkspacePayload, 'savedAt'>
): Promise<void> {
  const fullPayload: PersistedWorkspacePayload = {
    ...payload,
    savedAt: Date.now(),
  };
  const serialized = serializeForStorage(fullPayload);

  let savedToIdb = false;
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
      savedToIdb = true;
    } catch {
      savedToIdb = false;
    }
  }

  // Also keep localStorage synced when payload fits (< ~4MB) as instant/fallback backup
  if (typeof localStorage !== 'undefined') {
    try {
      const json = JSON.stringify(serialized);
      if (json.length < 4_000_000 || !savedToIdb) {
        localStorage.setItem(LS_FALLBACK_KEY, json);
      } else {
        localStorage.removeItem(LS_FALLBACK_KEY);
      }
    } catch {
      // Ignore quota exceeded on localStorage when IndexedDB succeeded
    }
  }
}

export async function loadPersistedWorkspace(): Promise<PersistedWorkspacePayload | null> {
  if (typeof indexedDB !== 'undefined') {
    try {
      const db = await openWorkspaceDb();
      const record = await new Promise<SerializedWorkspacePayload | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const req = store.get(RECORD_KEY);
        req.onsuccess = () => resolve(req.result as SerializedWorkspacePayload | undefined);
        req.onerror = () => reject(req.error ?? new Error('IDB read failed'));
      });
      db.close();
      const restored = deserializeFromStorage(record);
      if (restored) return restored;
    } catch {
      // Fall through to localStorage
    }
  }

  if (typeof localStorage !== 'undefined') {
    try {
      const rawJson = localStorage.getItem(LS_FALLBACK_KEY);
      if (!rawJson) return null;
      const parsed = JSON.parse(rawJson) as SerializedWorkspacePayload;
      return deserializeFromStorage(parsed);
    } catch {
      return null;
    }
  }

  return null;
}

export async function clearPersistedWorkspace(): Promise<void> {
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

  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.removeItem(LS_FALLBACK_KEY);
    } catch {
      // ignore
    }
  }
}
