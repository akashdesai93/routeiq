/**
 * A tiny async key-value store, the only way RouteIQ keeps anything on the
 * device. Each dataset gets a store (and a database) of its own, so data
 * under different licenses is never written to the same place.
 *
 * Neither method ever rejects: a store that cannot read answers null, and one
 * that cannot write drops the value. Callers treat both as "not cached".
 */
export interface KeyValueStore<T> {
  /** Null when there is nothing usable under the key. */
  get(key: string): Promise<T | null>
  put(key: string, value: T): Promise<void>
}

/** Kept in memory for as long as the page is open. Used in tests, and when IndexedDB is not there. */
export function memoryStore<T>(): KeyValueStore<T> {
  const values = new Map<string, T>()
  return {
    get: (key) => Promise.resolve(values.get(key) ?? null),
    put: (key, value) => {
      values.set(key, value)
      return Promise.resolve()
    },
  }
}

function defaultFactory(): IDBFactory | null {
  try {
    // Reading the property itself can throw where storage is blocked.
    return globalThis.indexedDB ?? null
  } catch {
    return null
  }
}

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
  })
}

/**
 * A store in the browser's IndexedDB: database `dbName`, with one object
 * store `storeName`, opened on first use. `isValid` checks every value read
 * back, so a record written by an older version or damaged on disk reads as
 * missing instead of being trusted.
 *
 * Where IndexedDB is missing or refuses to open (some private-browsing modes,
 * storage disabled, Node), it silently becomes a memory store for the
 * session. A single read or write that fails is treated as a miss.
 */
export function indexedDbStore<T>(
  dbName: string,
  storeName: string,
  isValid: (value: unknown) => value is T,
  factory: IDBFactory | null = defaultFactory(),
): KeyValueStore<T> {
  const memory = memoryStore<T>()
  let opening: Promise<IDBDatabase | null> | null = null

  const open = (): Promise<IDBDatabase | null> => {
    opening ??= new Promise<IDBDatabase | null>((resolve) => {
      if (factory === null) return resolve(null)
      try {
        const request = factory.open(dbName, 1)
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
    return opening
  }

  return {
    async get(key) {
      const db = await open()
      if (db === null) return memory.get(key)
      try {
        const value: unknown = await settled(db.transaction(storeName, 'readonly').objectStore(storeName).get(key))
        return isValid(value) ? value : null
      } catch {
        return null
      }
    },
    async put(key, value) {
      const db = await open()
      if (db === null) return memory.put(key, value)
      try {
        await settled(db.transaction(storeName, 'readwrite').objectStore(storeName).put(value, key))
      } catch {
        // Out of space or blocked: the value is simply not cached.
      }
    },
  }
}
