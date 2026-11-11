import { describe, expect, it } from 'vitest'
import { forgetOldSignalData, RETIRED_DATABASES } from '../src/signalData.ts'
import { deleteIndexedDb, indexedDbStore, memoryStore } from '../src/storage/kv.ts'

const isNumber = (value: unknown): value is number => typeof value === 'number'

interface FakeDbOptions {
  /** 'throw': open() throws. 'error': the open request fails. 'blocked': it reports blocked. */
  open?: 'throw' | 'error' | 'blocked'
  /** Every read and write request fails. */
  failRequests?: boolean
}

/**
 * A hand-written stand-in for the few parts of IndexedDB the store uses
 * (Vitest runs in Node, which has none). Requests settle on a later
 * microtask, as the real ones do. `databases` is what is "on disk".
 */
function fakeIndexedDb(options: FakeDbOptions = {}) {
  const databases = new Map<string, Map<string, Map<string, unknown>>>()
  let opened = 0
  const request = <T>(run: () => T) => {
    const req: { result?: T; error?: Error; onsuccess?: () => void; onerror?: () => void } = {}
    queueMicrotask(() => {
      if (options.failRequests) {
        req.error = new Error('request failed')
        req.onerror?.()
        return
      }
      req.result = run()
      req.onsuccess?.()
    })
    return req
  }
  const factory = {
    open(name: string) {
      opened++
      if (options.open === 'throw') throw new Error('SecurityError')
      const req: {
        result?: unknown
        onupgradeneeded?: () => void
        onsuccess?: () => void
        onerror?: () => void
        onblocked?: () => void
      } = {}
      queueMicrotask(() => {
        if (options.open === 'error') return req.onerror?.()
        if (options.open === 'blocked') return req.onblocked?.()
        const isNew = !databases.has(name)
        if (isNew) databases.set(name, new Map())
        const stores = databases.get(name)!
        req.result = {
          objectStoreNames: { contains: (store: string) => stores.has(store) },
          createObjectStore: (store: string) => stores.set(store, new Map()),
          transaction: (store: string) => ({
            objectStore: () => ({
              get: (key: string) => request(() => stores.get(store)!.get(key)),
              put: (value: unknown, key: string) => request(() => void stores.get(store)!.set(key, value)),
            }),
          }),
        }
        if (isNew) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
  }
  return { factory: factory as unknown as IDBFactory, databases, opened: () => opened }
}

describe('memoryStore', () => {
  it('keeps values by key and answers null for what it does not have', async () => {
    const store = memoryStore<number>()
    expect(await store.get('a')).toBeNull()
    await store.put('a', 1)
    await store.put('b', 2)
    await store.put('a', 3)
    expect(await store.get('a')).toBe(3)
    expect(await store.get('b')).toBe(2)
  })
})

describe('indexedDbStore', () => {
  it('writes to its own database and object store, and reads back on a later visit', async () => {
    const disk = fakeIndexedDb()
    const store = indexedDbStore('routeiq-test', 'numbers', isNumber, disk.factory)
    expect(await store.get('a')).toBeNull()
    await store.put('a', 1)
    expect(await store.get('a')).toBe(1)
    expect(disk.databases.get('routeiq-test')!.get('numbers')!.get('a')).toBe(1)
    // The database is opened once, on first use.
    expect(disk.opened()).toBe(1)
    // A new store object on the same "disk": a page reload.
    const later = indexedDbStore('routeiq-test', 'numbers', isNumber, disk.factory)
    expect(await later.get('a')).toBe(1)
  })

  it('keeps two datasets in two databases', async () => {
    const disk = fakeIndexedDb()
    await indexedDbStore('routeiq-one', 'data', isNumber, disk.factory).put('k', 1)
    await indexedDbStore('routeiq-two', 'data', isNumber, disk.factory).put('k', 2)
    expect([...disk.databases.keys()]).toEqual(['routeiq-one', 'routeiq-two'])
    expect(disk.databases.get('routeiq-one')!.get('data')!.get('k')).toBe(1)
    expect(disk.databases.get('routeiq-two')!.get('data')!.get('k')).toBe(2)
  })

  it('reads a stored value that fails the check as missing', async () => {
    const disk = fakeIndexedDb()
    const store = indexedDbStore('routeiq-test', 'numbers', isNumber, disk.factory)
    await store.put('a', 1)
    disk.databases.get('routeiq-test')!.get('numbers')!.set('a', 'damaged')
    expect(await store.get('a')).toBeNull()
  })

  it('falls back to memory, silently, where IndexedDB is missing or will not open', async () => {
    const unavailable = [
      null,
      fakeIndexedDb({ open: 'throw' }).factory,
      fakeIndexedDb({ open: 'error' }).factory,
      fakeIndexedDb({ open: 'blocked' }).factory,
    ]
    for (const factory of unavailable) {
      const store = indexedDbStore('routeiq-test', 'numbers', isNumber, factory)
      expect(await store.get('a')).toBeNull()
      await store.put('a', 1)
      // Good for the session, which is all memory can do.
      expect(await store.get('a')).toBe(1)
    }
    // Node has no IndexedDB at all: the default is the same fallback.
    const byDefault = indexedDbStore('routeiq-test', 'numbers', isNumber)
    await byDefault.put('a', 2)
    expect(await byDefault.get('a')).toBe(2)
  })

  it('treats a read or write that fails as a miss, and never rejects', async () => {
    const disk = fakeIndexedDb({ failRequests: true })
    const store = indexedDbStore('routeiq-test', 'numbers', isNumber, disk.factory)
    await expect(store.put('a', 1)).resolves.toBeUndefined()
    await expect(store.get('a')).resolves.toBeNull()
  })
})

describe('deleteIndexedDb and forgetOldSignalData', () => {
  /** A stand-in for IndexedDB's deleteDatabase: each request settles the way `outcome` says. */
  function deleter(outcome: 'success' | 'error' | 'blocked' | 'throw') {
    const deleted: string[] = []
    const factory = {
      deleteDatabase(name: string) {
        if (outcome === 'throw') throw new Error('SecurityError')
        const req: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void } = {}
        queueMicrotask(() => {
          if (outcome === 'success') {
            deleted.push(name)
            req.onsuccess?.()
          } else if (outcome === 'error') req.onerror?.()
          else req.onblocked?.()
        })
        return req
      },
    }
    return { factory: factory as unknown as IDBFactory, deleted }
  }

  it('deletes the database of the removed City of Charlotte list', async () => {
    const disk = deleter('success')
    await forgetOldSignalData(disk.factory)
    expect(disk.deleted).toEqual(['routeiq-charlotte-signals'])
    expect(RETIRED_DATABASES).toEqual(['routeiq-charlotte-signals'])
  })

  it('never rejects, whatever IndexedDB does, and does nothing without it', async () => {
    for (const outcome of ['error', 'blocked', 'throw'] as const) {
      await expect(deleteIndexedDb('routeiq-test', deleter(outcome).factory)).resolves.toBeUndefined()
    }
    await expect(deleteIndexedDb('routeiq-test', null)).resolves.toBeUndefined()
  })
})
