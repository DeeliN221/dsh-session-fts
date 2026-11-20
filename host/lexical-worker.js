import { parentPort, workerData } from 'node:worker_threads'
import { FtsStore } from './store.js'
import { ResultCache } from './cache.js'

let store
try {
  store = new FtsStore(workerData.path, workerData.optionsKey, workerData.config)
  parentPort.postMessage({ ready: true, revision: store.revision })
} catch (error) {
  parentPort.postMessage({ ready: false, error: { message: error.message, name: error.name, code: error.code } })
  parentPort.close()
}
const cache = new ResultCache(workerData.config.cacheSize ?? 100, workerData.config.cacheBytes ?? 8 * 1024 * 1024)
const methods = new Set(['sessionRow', 'sessionIds', 'commit', 'deleteSession', 'clear', 'stats', 'workspaces', 'search', 'searchTitles', 'close'])
if (store) parentPort.on('message', ({ id, method, args }) => {
  try {
    if (!methods.has(method)) throw new Error('session-fts: invalid worker method')
    let value
    let revision
    if (method === 'search' || method === 'searchTitles' || method === 'stats') {
      // The revision and result must describe one SQLite snapshot, including cache hits.
      store.db.exec('BEGIN')
      try {
        revision = store.revision
        const key = JSON.stringify([method, args])
        value = cache.get(key, revision)
        if (value === undefined) {
          value = store[method](...args)
          if (method === 'stats') value.revision = revision
          cache.set(key, revision, value)
        }
        store.db.exec('COMMIT')
      } catch (error) { store.db.exec('ROLLBACK'); throw error }
    } else {
      revision = store.revision
      value = store[method](...args)
      if (method !== 'close') revision = store.revision
    }
    parentPort.postMessage({ id, value, revision })
    if (method === 'close') parentPort.close()
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, name: error.name, code: error.code } })
  }
})
