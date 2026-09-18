import type { InventorySnapshot } from '../player/Inventory';
import type { StatsSnapshot } from '../player/Stats';
import type { ChunkEditRecord } from '../world/World';

const DB_NAME = 'voxelquest';
const DB_VERSION = 1;
const STORE = 'saves';
const SLOT = 'slot0';
export const SAVE_VERSION = 1;

export interface SaveData {
  version: number;
  savedAt: number;
  seed: number;
  /** Position in the day/night cycle, 0..1. Optional for older saves. */
  timeOfDay?: number;
  player: { x: number; y: number; z: number; yaw: number; pitch: number };
  stats: StatsSnapshot;
  inventory: InventorySnapshot;
  /**
   * Only player edits are stored. Terrain is regenerated from the seed on load,
   * which keeps saves tiny no matter how far the player has explored.
   */
  edits: ChunkEditRecord[];
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB'));
  });
}

export async function writeSave(data: SaveData): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(data, SLOT);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Save failed'));
      tx.onabort = () => reject(tx.error ?? new Error('Save aborted'));
    });
  } finally {
    db.close();
  }
}

export async function readSave(): Promise<SaveData | null> {
  const db = await openDb();
  try {
    return await new Promise<SaveData | null>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(SLOT);
      request.onsuccess = () => {
        const value = request.result as SaveData | undefined;
        // Refuse saves from a future or unknown format rather than crashing.
        if (!value || value.version !== SAVE_VERSION) resolve(null);
        else resolve(value);
      };
      request.onerror = () => reject(request.error ?? new Error('Load failed'));
    });
  } finally {
    db.close();
  }
}

export async function hasSave(): Promise<boolean> {
  try {
    return (await readSave()) !== null;
  } catch {
    return false;
  }
}

export async function clearSave(): Promise<void> {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(SLOT);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('Delete failed'));
    });
  } finally {
    db.close();
  }
}
