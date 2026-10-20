import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DocState } from '../engine/state';
import type { ResponseCache } from '../ai/pipelines';

/** Durable local state (IndexedDB): organized documents, source mappings and cached AI results. */

interface NotePilotDB extends DBSchema {
  docs: { key: string; value: DocState };
  cache: { key: string; value: { key: string; value: string; at: number }; indexes: { at: number } };
}

export interface DocStore {
  load(docId: string): Promise<DocState | null>;
  save(state: DocState): Promise<void>;
  remove(docId: string): Promise<void>;
  list(): Promise<{ docId: string; title: string; updatedAt: number }[]>;
  clearAll(): Promise<void>;
}

let dbPromise: Promise<IDBPDatabase<NotePilotDB>> | null = null;
function db() {
  dbPromise ??= openDB<NotePilotDB>('notepilot', 1, {
    upgrade(d) {
      d.createObjectStore('docs', { keyPath: 'docId' });
      d.createObjectStore('cache', { keyPath: 'key' }).createIndex('at', 'at');
    },
  });
  return dbPromise;
}

export const indexedDbStore: DocStore = {
  async load(docId) {
    return (await (await db()).get('docs', docId)) ?? null;
  },
  async save(state) {
    await (await db()).put('docs', state);
  },
  async remove(docId) {
    await (await db()).delete('docs', docId);
  },
  async list() {
    const all = await (await db()).getAll('docs');
    return all.map((s) => ({ docId: s.docId, title: s.title, updatedAt: s.organized.updatedAt })).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  async clearAll() {
    const d = await db();
    await d.clear('docs');
    await d.clear('cache');
  },
};

/** Non-persistent store used when "Store organized notes on this device" is off, and in tests. */
export function memoryStore(): DocStore {
  const m = new Map<string, DocState>();
  return {
    async load(id) {
      const s = m.get(id);
      return s ? structuredClone(s) : null;
    },
    async save(s) {
      m.set(s.docId, structuredClone(s));
    },
    async remove(id) {
      m.delete(id);
    },
    async list() {
      return [...m.values()].map((s) => ({ docId: s.docId, title: s.title, updatedAt: s.organized.updatedAt }));
    },
    async clearAll() {
      m.clear();
    },
  };
}

const CACHE_TTL = 24 * 3600_000;
const CACHE_MAX = 300;

export const responseCache: ResponseCache = {
  async get(key) {
    const row = await (await db()).get('cache', key);
    if (!row || Date.now() - row.at > CACHE_TTL) return undefined;
    return row.value;
  },
  async set(key, value) {
    const d = await db();
    await d.put('cache', { key, value, at: Date.now() });
    const count = await d.count('cache');
    if (count > CACHE_MAX) {
      // Evict oldest entries.
      const tx = d.transaction('cache', 'readwrite');
      let cursor = await tx.store.index('at').openCursor();
      let toDelete = count - CACHE_MAX;
      while (cursor && toDelete-- > 0) {
        await cursor.delete();
        cursor = await cursor.continue();
      }
      await tx.done;
    }
  },
};
