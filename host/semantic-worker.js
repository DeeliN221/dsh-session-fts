import { parentPort, workerData } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, openSync, closeSync, chmodSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as sqliteVec from 'sqlite-vec'
import lockfile from 'proper-lockfile'
import { makeSnippet } from './text.js'

const config = workerData
const options = config.semantic
let db, extractor, dimension, cacheReadOnly = false
let releaseLease, leaseError, leaseToken, stopping = false, retryTimer
const vectorPath = `${config.path}.semantic.sqlite`
const identity = JSON.stringify({ version: 1, model: options.model, dtype: 'q8', pooling: 'mean',
  normalize: true, chunkChars: options.chunkChars, prefix: 'e5' })
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function assertLease() {
  if (stopping) throw new Error('Semantic search is closing')
  if (leaseError) throw leaseError
  if (!releaseLease) throw new Error('Semantic refresh requires an exclusive cache lease')
}
async function unlock() {
  const release = releaseLease
  releaseLease = null
  if (release) await release().catch(() => {})
}
async function acquireLease() {
  mkdirSync(dirname(config.path), { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 30_000
  while (!stopping) {
    try {
      const release = await lockfile.lock(vectorPath, { realpath: false, stale: 10_000, update: 2_000,
        retries: 0, onCompromised: error => { leaseError = error } })
      if (stopping) { await release(); return false }
      releaseLease = release
      leaseError = null
      leaseToken = null
      return true
    } catch (error) {
      if (error.code !== 'ELOCKED') throw error
      if (!db) openReader()
      status({ phase: 'waiting', ready: Boolean(db), error: null, lastError: null })
      await serveQueries()
      if (Date.now() >= deadline) return false
      await delay(200)
    }
  }
  return false
}
function assertIdentity() {
  const stored = db.prepare("SELECT value FROM semantic_meta WHERE key='identity'").get()?.value
  if (stored !== identity) throw new Error('Semantic cache model or chunk settings differ; use a separate index path')
  dimension = Number(db.prepare("SELECT value FROM semantic_meta WHERE key='dimension'").get()?.value) || null
}
let state = { phase: 'loading', ready: false, done: 0, indexed: 0, total: 0,
  error: null, lastError: null, model: options.model }
const queries = []
const cache = new Map()
let needsCleanup = true
let running = false
const jobs = []
const yieldTurn = () => new Promise(resolve => setImmediate(resolve))
function status(patch) { state = { ...state, ...patch }; parentPort.postMessage({ status: state }) }
function errorMessage(error) {
  const cause = error?.cause
  const detail = cause?.code ?? cause?.message
  return `${String(error?.message ?? error)}${detail ? ` (${detail})` : ''}`
}
function reply(id, result, error) { if (id !== undefined) parentPort.postMessage({ id, result, error: error ? errorMessage(error) : undefined }) }

async function initialize() {
  if (extractor) return
  status({ phase: 'loading', ready: false, error: null, lastError: null })
  // Transformers only receives model identifiers and locally computed inputs. Its
  // network access downloads model assets; inference uses the CPU in this worker.
  const { pipeline, env } = await import('@huggingface/transformers')
  env.backends.onnx.numThreads = 1
  extractor = await pipeline('feature-extraction', options.model, {
    dtype: 'q8', device: 'cpu', cache_dir: options.cacheDir,
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' },
  })
}

function openReader() {
  let reader
  try {
    reader = new DatabaseSync(vectorPath, { readOnly: true, allowExtension: true })
    if (reader.prepare('PRAGMA application_id').get().application_id !== 0x44535356) { reader.close(); return }
    const stored = reader.prepare("SELECT value FROM semantic_meta WHERE key='identity'").get()?.value
    if (stored === undefined) { reader.close(); return }
    if (stored !== identity) throw new Error('Semantic cache model or chunk settings differ; use a separate index path')
    sqliteVec.load(reader)
    reader.enableLoadExtension(false)
    reader.exec('PRAGMA busy_timeout=3000')
    const sourceUri = pathToFileURL(resolve(config.path))
    sourceUri.searchParams.set('mode', 'ro')
    reader.prepare('ATTACH DATABASE ? AS source').run(sourceUri.href)
    db = reader
    cacheReadOnly = true
    assertIdentity()
  } catch (error) {
    if (reader) { try { reader.close() } catch {} }
    db = null
    if (error.message.includes('model or chunk settings differ')) throw error
    // The owner may still be creating the cache/schema. Retry on the next tick.
  }
}

function openCache() {
  assertLease()
  if (cacheReadOnly) { db.close(); db = null; cacheReadOnly = false }
  if (db) { assertIdentity(); return }
  closeSync(openSync(vectorPath, 'a', 0o600))
  db = new DatabaseSync(vectorPath, { allowExtension: true })
  const applicationId = db.prepare('PRAGMA application_id').get().application_id
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1").get()
  if (applicationId !== 0x44535356 && (applicationId !== 0 || hasTables)) {
    db.close()
    db = null
    throw new Error('Semantic cache path contains an unrelated database; choose another index path')
  }
  chmodSync(vectorPath, 0o600)
  db.exec('PRAGMA application_id=1146311510')
  sqliteVec.load(db)
  db.enableLoadExtension(false)
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;')
  const sourceUri = pathToFileURL(resolve(config.path))
  sourceUri.searchParams.set('mode', 'ro')
  db.prepare('ATTACH DATABASE ? AS source').run(sourceUri.href)
  db.exec(`CREATE TABLE IF NOT EXISTS semantic_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_documents(event_id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,hash TEXT NOT NULL,source_text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS semantic_chunks(id INTEGER PRIMARY KEY,event_id INTEGER NOT NULL,
      ordinal INTEGER NOT NULL,text TEXT NOT NULL,UNIQUE(event_id,ordinal));
    CREATE INDEX IF NOT EXISTS semantic_chunks_event ON semantic_chunks(event_id);`)
  const stored = db.prepare("SELECT value FROM semantic_meta WHERE key='identity'").get()?.value
  if (stored === undefined) db.prepare("INSERT INTO semantic_meta VALUES('identity',?)").run(identity)
  assertIdentity()
}

function cleanOrphans() {
  assertIdentity()
  // A terminated worker may leave a partially embedded document. It was never
  // made visible through semantic_documents; discard those chunks on restart.
  transaction(() => {
    if (dimension) db.exec('DELETE FROM semantic_vectors WHERE rowid IN (SELECT c.id FROM semantic_chunks c LEFT JOIN semantic_documents d ON d.event_id=c.event_id WHERE d.event_id IS NULL)')
    db.exec('DELETE FROM semantic_chunks WHERE event_id NOT IN (SELECT event_id FROM semantic_documents)')
  })

}

async function embed(texts) {
  const output = await extractor(texts, { pooling: 'mean', normalize: true })
  const vectors = output.tolist()
  if (!dimension) {
    dimension = vectors[0].length
    transaction(() => {
      db.exec(`CREATE VIRTUAL TABLE semantic_vectors USING vec0(embedding float[${dimension}] distance_metric=cosine)`)
      db.prepare("INSERT OR REPLACE INTO semantic_meta VALUES('dimension',?)").run(String(dimension))
    })
  }
  return vectors.map(vector => new Float32Array(vector))
}

function removeDocument(eventId) {
  if (dimension) db.prepare('DELETE FROM semantic_vectors WHERE rowid IN (SELECT id FROM semantic_chunks WHERE event_id=?)').run(eventId)
  db.prepare('DELETE FROM semantic_chunks WHERE event_id=?').run(eventId)
  db.prepare('DELETE FROM semantic_documents WHERE event_id=?').run(eventId)
}
function transaction(fn) {
  assertLease()
  db.exec('BEGIN IMMEDIATE')
  try {
    if (leaseToken && db.prepare("SELECT value FROM semantic_meta WHERE key='writer'").get()?.value !== leaseToken) {
      throw new Error('Semantic cache writer lease was replaced; retry refresh')
    }
    fn()
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}

async function serveQueries() {
  while (queries.length) {
    const job = queries.shift()
    try { reply(job.id, await search(job.query)) } catch (error) { reply(job.id, undefined, error) }
    await yieldTurn()
  }
}

async function refresh() {
  await initialize()
  if (!await acquireLease()) {
    if (!stopping && !retryTimer) retryTimer = setTimeout(() => {
      retryTimer = null
      jobs.push({ type: 'refresh' })
      void drain()
    }, 1000)
    return
  }
  try {
    openCache()
    // Fence every SQLite write as well as holding a heartbeat lease: a process
    // paused beyond the stale interval cannot resume writes over a new owner.
    const token = randomUUID()
    transaction(() => db.prepare("INSERT OR REPLACE INTO semantic_meta VALUES('writer',?)").run(token))
    leaseToken = token
    if (needsCleanup) { cleanOrphans(); needsCleanup = false }
    await reconcile()
  } finally { await unlock() }
}

async function reconcile() {
  status({ phase: 'indexing', ready: true, done: 0, total: db.prepare('SELECT count(*) AS n FROM source.events').get().n,
    error: null, lastError: null })
  const hasMeta = db.prepare("SELECT 1 FROM source.sqlite_master WHERE name='meta'").get()
  const generation = hasMeta ? db.prepare("SELECT value FROM source.meta WHERE key='generation'").get()?.value : undefined
  const previousGeneration = db.prepare("SELECT value FROM semantic_meta WHERE key='sourceGeneration'").get()?.value
  const full = generation === undefined || previousGeneration !== generation
  // Remove absent/replaced source rows before adding anything. This also handles
  // rowid reuse when the disposable FTS database is rebuilt.
  const obsolete = full ? db.prepare(`SELECT d.event_id FROM semantic_documents d LEFT JOIN source.events e
    ON e.id=d.event_id AND e.session_id=d.session_id AND e.seq=d.seq AND e.text=d.source_text
    WHERE e.id IS NULL`).all() : []
  transaction(() => { for (const row of obsolete) removeDocument(row.event_id) })
  let after = full ? 0 : Number(db.prepare("SELECT value FROM semantic_meta WHERE key='sourceCursor'").get()?.value ?? 0)
  let indexed = db.prepare('SELECT count(*) AS n FROM semantic_documents').get().n
  status({ indexed })
  while (true) {
    const events = db.prepare(`SELECT e.* FROM source.events e WHERE e.id>? AND NOT EXISTS (SELECT 1 FROM semantic_documents d WHERE d.event_id=e.id) ORDER BY e.id LIMIT ?`)
      .all(after, options.batchSize)
    if (!events.length) break
    for (const event of events) {
      after = event.id
      const hash = createHash('sha256').update(event.text).digest('hex')
      const previous = db.prepare('SELECT hash FROM semantic_documents WHERE event_id=?').get(event.id)
      if (previous?.hash === hash) { state.done++; continue }
      // A previous writer may have died after committing some chunks.
      transaction(() => removeDocument(event.id))
      // Only bounded chunk batches enter inference, even for very large events.
      const chunks = []
      for (let start = 0; start < event.text.length; start += options.chunkChars) {
        chunks.push(event.text.slice(start, start + options.chunkChars))
      }
      try {
        for (let start = 0; start < chunks.length; start += options.batchSize) {
          const batch = chunks.slice(start, start + options.batchSize)
          const vectors = await embed(batch.map(text => `passage: ${text}`))
          transaction(() => {
            for (let i = 0; i < batch.length; i++) {
              const id = db.prepare('INSERT INTO semantic_chunks(event_id,ordinal,text) VALUES(?,?,?) RETURNING id')
                .get(event.id, start + i, batch[i]).id
              db.prepare('INSERT INTO semantic_vectors(rowid,embedding) VALUES(?,?)').run(BigInt(id), vectors[i])
            }
          })
          await yieldTurn()
          await serveQueries()
        }
        transaction(() => db.prepare('INSERT INTO semantic_documents(event_id,session_id,seq,hash,source_text) VALUES(?,?,?,?,?)')
          .run(event.id, event.session_id, event.seq, hash, event.text))
      } catch (error) {
        needsCleanup = true
        transaction(() => { removeDocument(event.id) })
        throw error
      }
      state.done++
      indexed++
      status({ indexed })
      await yieldTurn()
      await serveQueries()
    }
    status({ done: state.done })
    await yieldTurn()
    await serveQueries()
  }
  transaction(() => {
    db.prepare("INSERT OR REPLACE INTO semantic_meta VALUES('sourceCursor',?)").run(String(after))
    db.prepare("INSERT OR REPLACE INTO semantic_meta VALUES('sourceGeneration',?)").run(generation ?? '')
  })
  status({ phase: 'ready', ready: true, indexed, done: state.done })
}

async function search(q) {
  if (!state.ready) throw new Error('Semantic search is not ready; refresh failed')
  const text = String(q.query ?? q.text ?? '').trim()
  if (!text) throw new Error('Semantic query must not be empty')
  const empty = { totalHits: 0, totalSessions: 0, truncated: false, sessions: [] }
  assertIdentity()
  if (!dimension || (Array.isArray(q.roles) && !q.roles.length)) return empty
  let vector = cache.get(text)
  if (vector) { cache.delete(text); cache.set(text, vector) }
  else {
    ;[vector] = await embed([`query: ${text}`])
    if (options.queryCacheSize > 0) {
      cache.set(text, vector)
      while (cache.size > options.queryCacheSize) cache.delete(cache.keys().next().value)
    }
  }
  assertIdentity()
  const where = ['e.text=d.source_text', 'e.session_id=d.session_id', 'e.seq=d.seq']
  const params = []
  if (q.from !== undefined) { where.push('e.time>=?'); params.push(q.from) }
  if (q.to !== undefined) { where.push('e.time<=?'); params.push(q.to) }
  if (q.roles !== undefined) { where.push(`e.role IN (${q.roles.map(() => '?').join(',')})`); params.push(...q.roles) }
  if (q.cwd !== undefined) { where.push('s.cwd=?'); params.push(q.cwd) }
  if (!q.includeSubagents) where.push("(s.origin IS NULL OR s.origin!='subagent')")
  if (q.excludeSessionId !== undefined) { where.push('e.session_id!=?'); params.push(q.excludeSessionId) }
  const candidates = Math.min(4096, Math.max(1, options.maxCandidates))
  // rowid IN is a vec0 prefilter: the native cosine KNN only considers
  // currently eligible chunks; JS never reads or scans stored embeddings.
  const rows = db.prepare(`SELECT v.distance,c.text,e.seq,e.role,e.time,e.session_id,s.title,s.cwd,
      s.created_at,s.updated_at,s.origin FROM (
      SELECT rowid,distance FROM semantic_vectors WHERE embedding MATCH ? AND k=? AND rowid IN (
        SELECT c.id FROM semantic_chunks c JOIN semantic_documents d ON d.event_id=c.event_id
        JOIN source.events e ON e.id=d.event_id JOIN source.sessions s ON s.id=e.session_id
        WHERE ${where.join(' AND ')})) v
      JOIN semantic_chunks c ON c.id=v.rowid JOIN semantic_documents d ON d.event_id=c.event_id
      JOIN source.events e ON e.id=d.event_id JOIN source.sessions s ON s.id=e.session_id ORDER BY v.distance`)
    .all(vector, BigInt(candidates), ...params)
  const groups = new Map()
  const events = new Set()
  for (const row of rows) {
    if (1 - row.distance < options.minScore) continue
    const key = JSON.stringify([row.session_id, row.seq])
    if (events.has(key)) continue
    events.add(key)
    let group = groups.get(row.session_id)
    if (!group) {
      group = { sessionId: row.session_id, title: row.title, cwd: row.cwd, createdAt: row.created_at,
        updatedAt: row.updated_at, subagent: row.origin === 'subagent', hits: 0, lastMatchAt: row.time,
        matches: [], best: row.distance }
      groups.set(row.session_id, group)
    }
    group.hits++
    group.lastMatchAt = Math.max(group.lastMatchAt, row.time)
    if (group.matches.length < 3) group.matches.push({ seq: row.seq, role: row.role, time: row.time,
      snippet: makeSnippet(row.text, q.terms ?? []) })
  }
  const ordered = [...groups.values()].sort(q.sort === 'recent'
    ? (a,b) => b.lastMatchAt - a.lastMatchAt : (a,b) => a.best - b.best)
  const sessions = ordered.slice(q.offset ?? 0, (q.offset ?? 0) + (q.limit ?? 20)).map(({ best, ...group }) => group)
  return { totalHits: events.size, totalSessions: ordered.length, truncated: rows.length === candidates, sessions }
}

parentPort.on('message', job => {
  if (job.type === 'close') {
    stopping = true
    clearTimeout(retryTimer)
    void unlock().finally(() => parentPort.postMessage({ closed: true }))
    return
  }
  if (stopping) return
  if (job.type === 'search') {
    if (!state.ready) { reply(job.id, undefined, new Error('Semantic search is not ready')); return }
    if (queries.length >= 8) { reply(job.id, undefined, new Error('Semantic search queue is full')); return }
    queries.push(job)
  } else jobs.push(job)
  void drain()
})
async function drain() {
  if (running) return
  running = true
  try {
    while (!stopping && (jobs.length || queries.length)) {
      await serveQueries()
      const job = jobs.shift()
      if (!job) continue
      try { await refresh(); reply(job.id) }
      catch (error) {
        if (db && !extractor) { try { db.close() } catch {} db = null }
        status({ phase: 'error', ready: false, error: errorMessage(error), lastError: errorMessage(error) })
        reply(job.id, undefined, error)
      }
    }
  } finally { running = false }
}
