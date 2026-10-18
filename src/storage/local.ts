/**
 * Almacenamiento local del dispositivo (caché de datos, cola de cambios
 * pendientes y conflictos). En el navegador se usa IndexedDB; en las
 * pruebas, memoria.
 */
export interface LocalStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
}

export class MemoryStore implements LocalStore {
  private m = new Map<string, string>();
  async get<T>(key: string) {
    const v = this.m.get(key);
    return v === undefined ? undefined : (JSON.parse(v) as T);
  }
  async set<T>(key: string, value: T) {
    this.m.set(key, JSON.stringify(value));
  }
  async del(key: string) {
    this.m.delete(key);
  }
}

/** IndexedDB con una sola tabla clave-valor. Se probará en el navegador en la fase (e). */
export class IdbStore implements LocalStore {
  private db: Promise<IDBDatabase>;

  constructor(name = "jornada") {
    this.db = new Promise((resolve, reject) => {
      const req = indexedDB.open(name, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.db;
    return new Promise<T>((resolve, reject) => {
      const t = db.transaction("kv", mode);
      const req = fn(t.objectStore("kv"));
      t.oncomplete = () => resolve(req.result as T);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  get<T>(key: string) {
    return this.tx<T | undefined>("readonly", (s) => s.get(key));
  }
  async set<T>(key: string, value: T) {
    await this.tx("readwrite", (s) => s.put(structuredClone(value), key));
  }
  async del(key: string) {
    await this.tx("readwrite", (s) => s.delete(key));
  }
}
