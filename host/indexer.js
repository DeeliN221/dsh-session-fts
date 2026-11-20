/**
 * Reconciles the local index with the Session corpus.
 *
 * A full pass runs at startup and on demand: every Session the query service
 * lists is compared with its stored stamp (persistence revision, or the live
 * event count), and only Sessions whose stamp changed are read. Sessions are
 * append-only, so a changed Session only appends events after the stored
 * `indexed_seq`. Live appends are coalesced per Session and indexed shortly
 * after they land. All work runs through one serial queue, and every Session
 * read yields to the event loop so the Host stays responsive.
 */

import { extractDocument } from './text.js'

const yieldTurn = () => new Promise(resolve => setImmediate(resolve))

export class Indexer {
  constructor(ctx, store, options) {
    this.ctx = ctx
    this.store = store
    this.options = options
    this.tail = Promise.resolve()
    this.state = { phase: 'idle', done: 0, total: 0, lastRun: null, lastError: null }
    this.pending = new Map()
    this.disposed = false
    this.onCommit = () => {}
  }

  _enqueue(task) {
    const run = this.tail.then(() => (this.disposed ? undefined : task()))
    this.tail = run.catch((error) => {
      this.state.lastError = String(error)
    })
    return run
  }

  /** Reconcile every Session; resolves when the pass ends. */
  reconcileAll() {
    return this._enqueue(() => this._reconcileAll())
  }

  /** Drop the index and rebuild it from the logs. */
  rebuild() {
    return this._enqueue(async () => {
      this.store.clear()
      await this._reconcileAll()
    })
  }

  /**
   * Coalesce live appends for one Session.
   * @param {string} sessionId - Session that appended an event.
   */
  touch(sessionId) {
    if (this.disposed || this.pending.has(sessionId)) return
    const timer = setTimeout(() => {
      this.pending.delete(sessionId)
      this._enqueue(() => this._reconcileOne(sessionId, undefined)).catch((error) => {
        this.ctx.logger?.warn?.(`session-fts: live index of ${sessionId} failed: ${String(error)}`)
      })
    }, this.options.liveDelayMs)
    this.pending.set(sessionId, timer)
  }

  /** Wait for queued work, including coalesced live updates. */
  async settle() {
    for (const [id, timer] of this.pending) {
      clearTimeout(timer)
      this.pending.delete(id)
      this._enqueue(() => this._reconcileOne(id, undefined)).catch(() => {})
    }
    await this.tail
  }

  async dispose() {
    this.disposed = true
    for (const timer of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    await this.tail
  }

  async _persistenceSnapshots() {
    const persistence = this.ctx.get('sessionPersistence')
    const map = new Map()
    if (persistence === undefined) return map
    for (const snapshot of await persistence.list()) map.set(snapshot.header.id, snapshot)
    return map
  }

  async _reconcileAll() {
    const started = Date.now()
    this.state = { ...this.state, phase: 'indexing', done: 0, total: 0, lastError: null }
    try {
      const records = await this.ctx.sessionQuery.listSessions()
      const snapshots = await this._persistenceSnapshots()
      this.state.total = records.length
      const seen = new Set()
      const failures = []
      for (const record of records) {
        if (this.disposed) return
        seen.add(record.header.id)
        try {
          await this._reconcileOne(record.header.id, snapshots.get(record.header.id))
        } catch (error) {
          failures.push(error)
          this.ctx.logger?.warn?.(`session-fts: index of ${record.header.id} failed: ${String(error)}`)
        }
        this.state.done++
        await yieldTurn()
      }
      for (const id of this.store.sessionIds()) {
        if (!seen.has(id)) this.store.deleteSession(id)
      }
      this.onCommit()
      if (failures.length) throw new AggregateError(failures, `${failures.length} sessions failed to index; retry scan`)
      this.state = { ...this.state, phase: 'idle', lastRun: { at: started, ms: Date.now() - started } }
    } catch (error) {
      this.state = { ...this.state, phase: 'idle', lastError: String(error) }
      throw error
    }
  }

  async _reconcileOne(sessionId, snapshot) {
    const live = this.ctx.sessions.get(sessionId)
    let stamp
    if (live !== undefined) {
      stamp = `live:${Number(live.seq)}`
    } else {
      const persisted = snapshot ?? await this.ctx.get('sessionPersistence')?.stat(sessionId)
      if (persisted === undefined) return
      if (persisted.formatStatus === 'migration-required') return
      stamp = `rev:${String(persisted.revision)}`
    }
    const stored = this.store.sessionRow(sessionId)
    if (stored !== undefined && stored.stamp === stamp) return

    let header
    let inherited
    let events
    if (live !== undefined) {
      header = live.header
      inherited = Number(live.inheritedEventCount)
      const from = Math.max(inherited, (stored?.indexed_seq ?? -1) + 1)
      events = live.snapshotEvents(from)
    } else {
      const log = await this.ctx.sessionQuery.readSession(sessionId)
      header = log.session
      inherited = Number(log.inheritedEventCount)
      const after = stored?.indexed_seq ?? -1
      events = log.events.filter(event => Number(event.seq) > after && Number(event.seq) >= inherited)
    }

    const docs = []
    let lastSeq = stored?.indexed_seq ?? -1
    let lastTime = stored?.updated_at ?? header.createdAt
    let title = stored?.title ?? null
    for (const event of events) {
      const seq = Number(event.seq)
      if (seq < inherited) continue
      if (seq > lastSeq) lastSeq = seq
      if (event.type === 'session/title' && typeof event.data?.title === 'string') title = event.data.title
      if (event.type === 'user/message' && event.data?.source?.kind === 'user' && event.time > lastTime) {
        lastTime = event.time
      }
      const doc = extractDocument(event, this.options)
      if (doc === null) continue
      const text = doc.text.length > this.options.maxDocChars ? doc.text.slice(0, this.options.maxDocChars) : doc.text
      docs.push({ seq, role: doc.role, time: event.time, text })
    }

    if (title === null && stored === undefined && inherited > 0) {
      // A fork inherits its title from the parent's part of the log.
      try {
        title = (await this.ctx.sessionQuery.readTitle(sessionId))?.title ?? null
      } catch { /* untitled */ }
    }

    this.store.commit({
      id: sessionId,
      cwd: header.cwd ?? null,
      parent: header.parentSession ?? null,
      origin: header.delegationDepth > 0 || header.parentSession !== undefined ? 'subagent' : (header.origin ?? null),
      title,
      created_at: header.createdAt,
      updated_at: lastTime,
      stamp,
      indexed_seq: lastSeq,
    }, docs)
    this.onCommit()
  }
}
