import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { SemanticSearch } from '../host/semantic.js'

function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'semantic-'))
  const path = join(dir, 'fts.sqlite')
  const db = new DatabaseSync(path)
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE sessions(id TEXT PRIMARY KEY,cwd TEXT,title TEXT,created_at INTEGER,updated_at INTEGER,origin TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY,session_id TEXT,seq INTEGER,role TEXT,time INTEGER,text TEXT);`)
  const config = { path, semantic: { enabled: true, model: 'test', cacheDir: join(dir,'models'),
    batchSize: 2, chunkChars: 20, queryCacheSize: 2, minScore: .5, maxCandidates: 20, ...overrides } }
  const semantic = new SemanticSearch(config)
  t.after(async () => { await semantic.close(); db.close(); rmSync(dir, { recursive: true, force: true }) })
  const add = (id, text, cwd = '/a', role = 'user', origin = null, time = 10) => {
    db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(String(id),cwd,`Title ${id}`,1,time,origin)
    db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?)').run(id,String(id),id,role,time,text)
  }
  const query = (extra = {}) => semantic.search({ query: '苹果', terms: [], offset: 0, limit: 20, sort: 'relevance', ...extra })
  return { semantic, db, add, query, config, dir }
}

test('native cosine KNN, grouping, prefilters, live deletes and metadata', async t => {
  const f = fixture(t, { maxCandidates: 1 })
  f.add(1,'apple','/wrong')
  f.add(2,'apple','/a')
  f.add(3,'banana','/a')
  f.add(4,'apple','/a','assistant','subagent',30)
  await assert.rejects(f.query(), /not ready/)
  await f.semantic.refresh()
  assert.equal(f.semantic.status.phase,'ready')
  assert.equal(f.semantic.status.indexed,4)
  assert.equal(statSync(`${f.config.path}.semantic.sqlite`).mode & 0o777,0o600)
  const result = await f.query({ cwd: '/a' })
  assert.equal(result.sessions[0].sessionId,'2')
  assert.equal(result.sessions[0].matches[0].snippet,'apple')
  assert.equal((await f.query({ roles: [] })).totalHits,0)
  assert.equal((await f.query({ cwd:'/a',roles:['assistant'] })).totalHits,0)
  assert.equal((await f.query({ cwd:'/a',roles:['assistant'],includeSubagents:true })).sessions[0].sessionId,'4')
  assert.equal((await f.query({ cwd:'/a',from:20 })).totalHits,0)
  assert.equal((await f.query({ cwd:'/a',to:5 })).totalHits,0)
  assert.equal((await f.query({ cwd:'/a',excludeSessionId:'2' })).totalHits,0)
  f.db.exec("UPDATE sessions SET title='Renamed' WHERE id='2'")
  assert.equal((await f.query({ cwd:'/a' })).sessions[0].title,'Renamed')
  f.db.exec("UPDATE events SET text='banana' WHERE id=2")
  assert.equal((await f.query({ cwd:'/a' })).totalHits,0)
  f.db.exec('DELETE FROM events WHERE id=1')
  assert.equal((await f.query()).totalHits,0)
  await f.semantic.refresh()
  const derived = new DatabaseSync(`${f.config.path}.semantic.sqlite`)
  assert.equal(derived.prepare('SELECT count(*) AS n FROM semantic_documents WHERE event_id=1').get().n,0)
  derived.close()
})

test('persistent hash/model cache, query LRU, chunk batching and restart recovery', async t => {
  const f = fixture(t)
  const log = join(f.dir,'embed.log')
  process.env.SEMANTIC_EMBED_LOG = log
  t.after(() => { delete process.env.SEMANTIC_EMBED_LOG })
  f.add(1,'apple '.repeat(15))
  f.add(2,'banana')
  await f.semantic.refresh()
  await f.query()
  await f.query()
  let calls = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
  assert.ok(calls.every(batch => batch.length <= 2))
  assert.equal(calls.flat().filter(text=>text.startsWith('query:')).length,1)
  const passages = calls.flat().filter(text=>text.startsWith('passage:')).length
  await f.semantic.close()
  const restarted = new SemanticSearch(f.config)
  t.after(() => restarted.close())
  await restarted.refresh()
  calls = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(calls.flat().filter(text=>text.startsWith('passage:')).length,passages)
  assert.equal((await restarted.search({ query:'apple' })).sessions[0].hits,1)
  await restarted.close()
  const changed = new SemanticSearch({ ...f.config, semantic:{ ...f.config.semantic, model:'changed' } })
  t.after(() => changed.close())
  await assert.rejects(changed.refresh(), /model or chunk settings differ/)
  calls = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(calls.flat().filter(text=>text.startsWith('passage:')).length,passages)
})

test('model errors propagate, crash rejects pending work, teardown aborts warmup', async t => {
  const f = fixture(t,{ model:'fail' })
  await assert.rejects(f.semantic.refresh(),/Model unavailable/)
  assert.equal(f.semantic.status.phase,'error')
  const slow = new SemanticSearch({ ...f.config, semantic:{ ...f.config.semantic,model:'hang' } })
  const pending = slow.refresh()
  const rejected = assert.rejects(pending,/closed/)
  await slow.close()
  await rejected
  const crash = new SemanticSearch({ ...f.config, semantic:{ ...f.config.semantic,model:'hang' } })
  t.after(()=>crash.close())
  const crashed = assert.rejects(crash.refresh(),/exited unexpectedly/)
  await crash.worker.terminate()
  await crashed
  assert.equal(crash.status.phase,'error')
})

test('foreign databases are rejected without schema changes', async t => {
  const f=fixture(t)
  const foreign=new DatabaseSync(`${f.config.path}.semantic.sqlite`)
  foreign.exec('CREATE TABLE precious(value TEXT); INSERT INTO precious VALUES(\'keep\')')
  foreign.close()
  await assert.rejects(f.semantic.refresh(),/unrelated database/)
  const verify=new DatabaseSync(`${f.config.path}.semantic.sqlite`)
  assert.equal(verify.prepare('SELECT value FROM precious').get().value,'keep')
  assert.equal(verify.prepare('PRAGMA application_id').get().application_id,0)
  verify.close()
})

function childSearch(config, log) {
  const env = { ...process.env, SEMANTIC_PROCESS_CONFIG: JSON.stringify(config),
    SEMANTIC_EMBED_LOG: log, SEMANTIC_EMBED_DELAY: '80' }
  delete env.NODE_TEST_CONTEXT
  const child = fork(fileURLToPath(new URL('./semantic-process.js', import.meta.url)), [], {
    env, execArgv: ['--import',fileURLToPath(new URL('./semantic-preload.js',import.meta.url))],
    stdio: ['ignore','ignore','pipe','ipc'] })
  let nextId = 0
  let status = {}
  let stderr = ''
  const pending = new Map()
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('message', message => {
    if (message.status) { status = message.status; return }
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.error) request.reject(new Error(message.error))
    else request.resolve(message.result)
  })
  const exited = new Promise(resolve => child.on('exit', (code,signal) => {
    for (const request of pending.values()) request.reject(new Error(`child exited ${code}/${signal}: ${stderr}`))
    pending.clear()
    resolve()
  }))
  function request(type, query) {
    return new Promise((resolve,reject) => {
      const id = ++nextId
      pending.set(id,{resolve,reject})
      child.send({id,type,query})
    })
  }
  return { request, get status() { return status },
    async kill() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited },
    async close() {
      if (child.connected) await request('close')
      await exited
    } }
}
async function until(condition, message) {
  const deadline = Date.now() + 20_000
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await new Promise(resolve => setTimeout(resolve,20))
  }
}

test('separate processes serialize refresh, query while waiting, recover killed owner and preserve identity', { timeout: 30_000 }, async t => {
  const f = fixture(t, { maxCandidates: 200 })
  f.add(1,'apple')
  f.add(2,'banana')
  const log = join(f.dir,'process-embeddings.log')
  const a = childSearch(f.config,log)
  const b = childSearch(f.config,log)
  let c, reader
  try {
    await Promise.all([a.request('refresh'),b.request('refresh')])
    const calls = readFileSync(log,'utf8').trim().split('\n').map(JSON.parse).flat()
    assert.equal(calls.filter(text => text.startsWith('passage:')).length,2,'each document embedded once across processes')
    assert.equal((await b.request('search',{query:'apple'})).sessions[0].sessionId,'1')
    f.add(3,'apple '.repeat(100))
    const ownerRefresh = a.request('refresh')
    const ownerFailure = assert.rejects(ownerRefresh,/child exited/)
    const lockPath = `${f.config.path}.semantic.sqlite.lock`
    await until(() => existsSync(lockPath),'owner has acquired refresh lease')
    const followerRefresh = b.request('refresh')
    await until(() => b.status.phase === 'waiting','follower is waiting for owner')
    assert.equal(b.status.ready,true)
    assert.equal((await b.request('search',{query:'apple'})).sessions[0].sessionId,'1','reader serves while writer is active')
    reader = childSearch(f.config,log)
    const readerRefresh = assert.rejects(reader.request('refresh'),/child exited/)
    await until(() => reader.status.phase === 'waiting' && reader.status.ready,'fresh follower opens the shared cache read-only')
    assert.equal((await reader.request('search',{query:'apple'})).sessions[0].sessionId,'1')
    await reader.kill()
    await readerRefresh
    // The owner has committed some unpublished chunks and is in another batch.
    await a.kill()
    await ownerFailure
    await followerRefresh
    assert.equal((await b.request('search',{query:'apple'})).totalSessions,2)
    const derived = new DatabaseSync(`${f.config.path}.semantic.sqlite`)
    assert.equal(derived.prepare('SELECT count(*) AS n FROM semantic_documents').get().n,3)
    assert.equal(derived.prepare('SELECT count(*) AS n FROM semantic_chunks c LEFT JOIN semantic_documents d ON d.event_id=c.event_id WHERE d.event_id IS NULL').get().n,0)
    derived.close()
    c = childSearch({...f.config,semantic:{...f.config.semantic,model:'different-model'}},log)
    await assert.rejects(c.request('refresh'),/model or chunk settings differ/)
    assert.equal((await b.request('search',{query:'apple'})).totalSessions,2,'conflicting model never resets active cache')
    await b.close()
    assert.equal(existsSync(lockPath),false,'graceful shutdown releases lease')
  } finally {
    await a.kill()
    await b.kill()
    if (c) await c.kill()
    if (reader) await reader.kill()
  }
})

test('query queue stays bounded while refresh yields between batches', async t => {
  const f=fixture(t)
  f.add(1,'apple')
  await f.semantic.refresh()
  f.add(2,'apple '.repeat(100))
  const refresh=f.semantic.refresh()
  const results=await Promise.allSettled(Array.from({length:12},()=>f.query()))
  assert.ok(results.some(r=>r.status==='rejected' && /queue is full/.test(r.reason.message)))
  assert.ok(results.some(r=>r.status==='fulfilled'))
  await refresh
})
