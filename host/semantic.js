/** Local semantic search runs entirely in a disposable worker and derived SQLite cache. */
import { Worker } from 'node:worker_threads'

export class SemanticSearch {
  constructor(config) {
    this.config = config
    this.status = { phase: config.semantic.enabled ? 'idle' : 'disabled', ready: false,
      done: 0, indexed: 0, total: 0, error: null, lastError: null, model: config.semantic.model }
    this.worker = null
    this.pending = new Map()
    this.nextId = 0
    this.closed = false
    this.refreshing = null
  }

  _start() {
    if (this.worker) return
    const worker = new Worker(new URL('./semantic-worker.js', import.meta.url), { workerData: this.config })
    this.worker = worker
    worker.on('message', message => {
      if (message.status) { this.status = message.status; return }
      const request = this.pending.get(message.id)
      if (!request) return
      this.pending.delete(message.id)
      if (message.error) request.reject(new Error(message.error))
      else request.resolve(message.result)
    })
    const fail = error => {
      if (!this.closed) this.status = { ...this.status, phase: 'error', ready: false, error: error.message, lastError: error.message }
      for (const request of this.pending.values()) request.reject(error)
      this.pending.clear()
    }
    worker.on('error', fail)
    worker.on('exit', code => {
      if (this.worker === worker) this.worker = null
      if (!this.closed) fail(new Error(`Semantic worker exited unexpectedly (code ${code})`))
    })
  }

  _request(type, query) {
    if (this.closed) return Promise.reject(new Error('Semantic search is closed'))
    if (!this.config.semantic.enabled) return Promise.reject(new Error('Semantic search is disabled'))
    if (this.pending.size >= 8) return Promise.reject(new Error('Semantic search queue is full; retry shortly'))
    this._start()
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, type, query })
    })
  }

  /** Warm the model lazily and reconcile derived chunks after lexical indexing. */
  refresh() {
    if (!this.config.semantic.enabled || this.closed) return Promise.resolve()
    if (this.refreshing) { this.refreshAgain = true; return this.refreshing }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false
        await this._request('refresh')
      } while (this.refreshAgain && !this.closed)
    })().finally(() => { this.refreshing = null })
    return this.refreshing
  }

  search(normalizedRequest) {
    if (this.closed) return Promise.reject(new Error('Semantic search is closed'))
    if (!this.status.ready) return Promise.reject(new Error(`Semantic search is not ready (${this.status.phase}); allow background model warmup and indexing to finish`))
    return this._request('search', normalizedRequest)
  }

  async close() {
    if (this.closed) return
    this.closed = true
    this.status = { ...this.status, phase: 'closed', ready: false }
    for (const request of this.pending.values()) request.reject(new Error('Semantic search is closed'))
    this.pending.clear()
    // Termination also interrupts downloads/inference without waiting for the model.
    const worker = this.worker
    this.worker = null
    if (worker) await worker.terminate()
  }
}
