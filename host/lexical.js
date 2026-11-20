import { Worker } from 'node:worker_threads'

const failure = (message, code, name = 'Error') => Object.assign(new Error(message), { code, name })
const remoteError = error => Object.assign(new Error(error.message), error)

/**
 * All SQLite work (including opening/status/closing) runs in a dedicated worker.
 * `sourceId` is a stable identity for the COMPLETE source corpus, not a process id.
 * Use separate files for different corpora; a partial scan must never prune this file.
 * `revision` is only the last observed global revision. Search caches belong to the
 * worker and validate against SQLite on every call, even after another process writes.
 * Query abort/timeout cancels queued execution or discards an active result; it cannot
 * interrupt a synchronous SQLite call. That call retains its queue slot until done.
 */
export class AsyncFtsStore {
  constructor(path, optionsKey, config = {}) {
    this.path = path
    this.revision = 0
    this.maxPending = config.maxPending ?? 64
    this.closeTimeoutMs = config.closeTimeoutMs ?? 5000
    if (!Number.isSafeInteger(this.maxPending) || this.maxPending < 1) throw new TypeError('invalid maxPending')
    if (!Number.isSafeInteger(this.closeTimeoutMs) || this.closeTimeoutMs < 1) throw new TypeError('invalid closeTimeoutMs')
    for (const key of ['cacheSize', 'cacheBytes']) {
      if (config[key] !== undefined && (!Number.isSafeInteger(config[key]) || config[key] < 0)) throw new TypeError(`invalid ${key}`)
    }
    this.queue = []
    this.active = null
    this.nextId = 1
    this.closing = false
    this.failure = null
    this.initialized = false
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject })
    // Initialization may fail before the integrator first awaits ready.
    this.ready.catch(() => {})
    this.worker = new Worker(new URL('./lexical-worker.js', import.meta.url), { workerData: { path, optionsKey, config } })
    this.worker.on('message', message => this._message(message))
    this.worker.on('error', error => this._fail(error))
    this.worker.on('exit', code => {
      if (!this.closed) this._fail(failure(`session-fts: lexical worker exited (${code})`, 'WORKER_EXIT'))
    })
  }

  _message(message) {
    if ('ready' in message) {
      if (!message.ready) { this._fail(remoteError(message.error)); return }
      this.initialized = true
      this.revision = message.revision
      this.resolveReady(this)
      this._pump()
      return
    }
    const item = this.active
    if (!item || item.id !== message.id) return
    this.active = null
    item.cleanup()
    if (message.revision !== undefined) this.revision = message.revision
    if (message.error) item.reject(remoteError(message.error))
    else item.resolve(message.value)
    if (item.method === 'close') this.closed = true
    this._pump()
  }

  _fail(error) {
    this.failure ??= error
    this.rejectReady(this.failure)
    for (const item of [this.active, ...this.queue]) {
      if (item) { item.cleanup(); item.reject(this.failure) }
    }
    this.active = null
    this.queue = []
  }

  _pump() {
    if (!this.initialized || this.active || this.failure) return
    const item = this.queue.shift()
    if (!item) return
    this.active = item
    try { this.worker.postMessage({ id: item.id, method: item.method, args: item.args }) }
    catch (error) { this._fail(error) }
  }

  _call(method, args, options = {}) {
    if (this.failure) return Promise.reject(this.failure)
    if (this.closing && method !== 'close') return Promise.reject(failure('session-fts: store closed', 'STORE_CLOSED'))
    if (options.signal?.aborted) return Promise.reject(failure('session-fts: query aborted', 'ABORT_ERR', 'AbortError'))
    if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)) return Promise.reject(new TypeError('invalid timeoutMs'))
    if (method !== 'close' && this.queue.length + Number(!!this.active) >= this.maxPending) return Promise.reject(failure('session-fts: lexical queue full', 'QUEUE_FULL'))
    return new Promise((resolve, reject) => {
      const item = { id: this.nextId++, method, args, resolve, reject }
      let timer
      const cancel = code => {
        const index = this.queue.indexOf(item)
        if (index !== -1) this.queue.splice(index, 1)
        item.cleanup()
        reject(failure(code === 'ABORT_ERR' ? 'session-fts: query aborted' : 'session-fts: query timed out', code, code === 'ABORT_ERR' ? 'AbortError' : 'TimeoutError'))
      }
      const abort = () => cancel('ABORT_ERR')
      item.cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort) }
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.timeoutMs !== undefined) timer = setTimeout(() => cancel('QUERY_TIMEOUT'), options.timeoutMs)
      this.queue.push(item)
      this._pump()
    })
  }

  sessionRow(id) { return this._call('sessionRow', [id]) }
  sessionIds() { return this._call('sessionIds', []) }
  commit(row, docs) { return this._call('commit', [row, docs]) }
  deleteSession(id) { return this._call('deleteSession', [id]) }
  clear() { return this._call('clear', []) }
  stats() { return this._call('stats', []) }
  workspaces() { return this._call('workspaces', []) }
  search(query, options) { return this._call('search', [query], options) }
  searchTitles(query, options) { return this._call('searchTitles', [query], options) }

  close() {
    if (this.closePromise) return this.closePromise
    this.closing = true
    this.closePromise = (async () => {
      let timer
      try {
        await Promise.race([
          this._call('close', []),
          new Promise((_, reject) => { timer = setTimeout(() => reject(failure('session-fts: close timed out', 'CLOSE_TIMEOUT')), this.closeTimeoutMs) }),
        ])
      } finally {
        clearTimeout(timer)
        this.closed = true
        this._fail(failure('session-fts: store closed', 'STORE_CLOSED'))
        await this.worker.terminate()
      }
    })()
    return this.closePromise
  }
}
