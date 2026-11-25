/**
 * The planner keeps working between sessions: the plan (draft placements,
 * pins, view settings) and each draft's image bytes live in IndexedDB,
 * independent of any .vpost document.
 */
const DB = 'tiovivo-grid'
const STORE = 'kv'

let dbPromise: Promise<IDBDatabase> | null = null

function db(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => { req.result.createObjectStore(STORE) }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  dbPromise.catch(() => { dbPromise = null })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return db().then((d) => new Promise<T | undefined>((resolve, reject) => {
    const t = d.transaction(STORE, mode)
    const req = run(t.objectStore(STORE))
    t.oncomplete = () => resolve(req ? req.result : undefined)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

export const kvGet = <T>(key: string) => tx<T>('readonly', (s) => s.get(key) as IDBRequest<T>)
export const kvSet = (key: string, value: unknown) => tx('readwrite', (s) => { s.put(value, key) })
export const kvDelete = (key: string) => tx('readwrite', (s) => { s.delete(key) })
