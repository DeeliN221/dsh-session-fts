import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { FtsStore } from '../host/store.js'
import { ResultCache } from '../host/cache.js'
import { compileQuery } from '../host/text.js'
import { Indexer } from '../host/indexer.js'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-search-test-'))
  const store = new FtsStore(join(root, 'index.sqlite'), 'test')
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return store
}
function row(id, title = '索引缓存设计', origin = null) {
  return { id, cwd: '/project', parent: null, origin, title, created_at: 1, updated_at: 100,
    stamp: 'rev:1', indexed_seq: 1 }
}
function query(text, extra = {}) {
  return { ...compileQuery(text), limit: 20, offset: 0, sort: 'relevance', ...extra }
}

test('Chinese middle-of-sentence fulltext and separate title filtering', t => {
  const store = fixture(t)
  store.commit(row('a'), [{ seq: 1, role: 'user', time: 100, text: '现在需要强化全文搜索功能并关注性能' }])
  store.commit(row('b', '全文搜索', 'subagent'), [{ seq: 1, role: 'assistant', time: 100, text: '其他消息' }])
  assert.deepEqual(store.search(query('全文搜索')).sessions.map(s => s.sessionId), ['a'])
  assert.equal(store.searchTitles(query('缓存')).sessions[0].sessionId, 'a')
  assert.equal(store.searchTitles(query('全文搜索')).sessions.length, 0)
  assert.equal(store.searchTitles(query('全文搜索', { includeSubagents: true })).sessions[0].sessionId, 'b')
  assert.equal(store.search(query('全文搜索', { roles: [] })).sessions.length, 0)
  assert.equal(store.search(query('全文搜索', { from: 101 })).sessions.length, 0)
  assert.equal(store.search(query('全文搜索', { cwd: '/other' })).sessions.length, 0)
  assert.equal(store.searchTitles(query('缓存', { excludeSessionId: 'a' })).sessions.length, 0)
  assert.equal(store.search(query('" OR *')).sessions.length, 0)
  const revision = store.revision
  store.deleteSession('a')
  assert.ok(store.revision > revision)
  assert.equal(store.search(query('全文搜索')).sessions.length, 0)
})

test('bounded cache evicts LRU, clones values and invalidates all on revision change', () => {
  const cache = new ResultCache(2, 200)
  cache.set('a', 1, { text: 'one' })
  cache.set('b', 1, { text: 'two' })
  const a = cache.get('a', 1)
  a.text = 'modified'
  assert.equal(cache.get('a', 1).text, 'one')
  cache.set('c', 1, { text: 'three' })
  assert.equal(cache.get('b', 1), undefined)
  cache.set('large', 1, { text: 'x'.repeat(300) })
  assert.equal(cache.get('large', 1), undefined)
  assert.ok(cache.bytes <= 200)
  assert.equal(cache.get('a', 2), undefined)
  assert.equal(cache.bytes, 0)
})

test('refuses foreign databases without changing their tables', t => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-search-foreign-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const path = join(root, 'foreign.sqlite')
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE events(secret TEXT); INSERT INTO events VALUES (\'keep\')')
  db.close()
  assert.throws(() => new FtsStore(path, 'test'), /unrecognized database/)
  const verify = new DatabaseSync(path)
  assert.equal(verify.prepare('SELECT secret FROM events').get().secret, 'keep')
  verify.close()
})

test('persists index and creates private files', t => {
  const store = fixture(t)
  store.commit(row('a'), [{ seq: 1, role: 'user', time: 100, text: '性能预加载' }])
  const reopened = new FtsStore(store.path, 'test')
  assert.equal(reopened.search(query('预加载')).sessions[0].sessionId, 'a')
  reopened.close()
  if (process.platform !== 'win32') assert.equal(statSync(store.path).mode & 0o777, 0o600)
})

test('indexer skips unchanged revisions and reports incomplete scans', async t => {
  const store = fixture(t)
  let reads = 0
  let fail = false
  const snapshot = { header: { id: 'a' }, revision: 'one' }
  const ctx = { sessions: { get: () => undefined }, get: () => ({ list: async () => [snapshot] }),
    sessionQuery: { listSessions: async () => [{ header: { id: 'a' } }], readSession: async () => {
      reads++
      if (fail) throw new Error('read failed')
      return { session: { id: 'a', cwd: '/project', createdAt: 1 }, inheritedEventCount: 0,
        events: [{ type: 'user/message', seq: 1, time: 100, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '增量索引' }] } }] }
    } } }
  const indexer = new Indexer(ctx, store, { tools: false, maxDocChars: 20000, liveDelayMs: 1500 })
  await indexer.reconcileAll()
  await indexer.reconcileAll()
  assert.equal(reads, 1)
  fail = true
  snapshot.revision = 'two'
  await assert.rejects(indexer.reconcileAll(), /failed to index/)
  assert.match(indexer.state.lastError, /failed to index/)
  assert.equal(store.search(query('索引')).sessions.length, 1)
  await indexer.dispose()
})
