import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { AsyncFtsStore } from '../host/lexical.js'
import { compileQuery } from '../host/text.js'

const query = text => ({ ...compileQuery(text), limit: 20, offset: 0, sort: 'relevance' })
const row = (id, seq = 1) => ({ id, cwd: '/test', parent: null, origin: null, title: 'searchable title', created_at: 1, updated_at: seq, stamp: String(seq), indexed_seq: seq })
const docs = seq => [{ seq, role: 'user', time: seq, text: 'searchable corpus' }]
async function fixture(t, config = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexical-'))
  const path = join(root, 'index.sqlite')
  const stores = []
  t.after(async () => {
    await Promise.all(stores.map(store => store.close().catch(() => {})))
    await rm(root, { recursive: true, force: true })
  })
  const open = (key = 'shared', options = {}) => {
    const store = new AsyncFtsStore(path, key, { sourceId: 'corpus', ...config, ...options })
    stores.push(store)
    return store
  }
  return { path, open }
}
function child(path, mode, identity) {
  const process = fork(new URL('./lexical-child.mjs', import.meta.url), [path, mode, ...(identity ? [identity] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  let stderr = ''
  process.stderr.on('data', data => { stderr += data })
  const messages = []
  process.on('message', message => messages.push(message))
  const done = once(process, 'exit').then(([code]) => ({ code, messages, stderr }))
  return { process, done }
}

test('actual processes create, append duplicate documents, and reopen one shared index', async t => {
  const { path, open } = await fixture(t)
  const children = Array.from({ length: 4 }, () => child(path, 'write'))
  t.after(() => children.forEach(c => { if (c.process.exitCode === null) c.process.kill() }))
  const results = await Promise.all(children.map(c => c.done))
  for (const result of results) assert.equal(result.code, 0, JSON.stringify(result))
  const store = open()
  await store.ready
  const stats = await store.stats()
  assert.equal(stats.documents, 40)
  assert.equal(stats.sessions, 1)
  assert.equal(stats.revision, 160)
  const stored = await store.sessionRow('shared-session')
  assert.equal(stored.doc_count, 40)
  assert.equal(stored.indexed_seq, 39)
  assert.equal(stored.title, 'title 39')
  assert.equal((await store.search(query('searchable'))).totalHits, 40)
  await store.close()
  const reopened = child(path, 'read')
  const result = await reopened.done
  assert.equal(result.code, 0, result.stderr)
  assert.equal(result.messages[0].stats.revision, 160)
})

test('live shared readers invalidate cached search and titles after another process writes', async t => {
  const { path, open } = await fixture(t)
  const store = open()
  await store.ready
  assert.equal((await store.search(query('searchable'))).totalHits, 0)
  assert.equal((await store.searchTitles(query('title'))).totalHits, 0)
  const writer = child(path, 'write')
  assert.equal((await writer.done).code, 0)
  assert.equal((await store.search(query('searchable'))).totalHits, 40)
  assert.equal((await store.searchTitles(query('title'))).totalHits, 1)
  const beforeClear = (await store.stats()).revision
  assert.equal((await child(path, 'clear').done).code, 0)
  assert.equal((await store.search(query('searchable'))).totalHits, 0)
  assert.equal((await store.searchTitles(query('title'))).totalHits, 0)
  assert.ok((await store.stats()).revision > beforeClear)
  const revision = (await store.stats()).revision
  await store.deleteSession('shared-session')
  assert.ok((await store.stats()).revision > revision)
  assert.equal((await store.search(query('searchable'))).totalHits, 0)
})

test('incompatible options and source identities fail without erasing a live index', async t => {
  const { path, open } = await fixture(t)
  const store = open()
  await store.commit(row('keep'), docs(1))
  for (const [mode, source] of [['mismatch', 'corpus'], ['read', 'other-corpus']]) {
    const result = await child(path, mode, source).done
    assert.equal(result.code, 1)
    assert.match(result.messages[0].error, /incompatible/)
  }
  assert.equal((await store.stats()).documents, 1)
  assert.equal((await store.search(query('searchable'))).sessions[0].sessionId, 'keep')
})

test('bounded queue, abort, timeout, graceful disposal, and failed startup settle every request', async t => {
  const { open } = await fixture(t, { maxPending: 2 })
  const store = open()
  const first = store.stats()
  const controller = new AbortController()
  const queued = store.search(query('searchable'), { signal: controller.signal })
  const aborted = assert.rejects(queued, { code: 'ABORT_ERR' })
  await assert.rejects(store.stats(), { code: 'QUEUE_FULL' })
  controller.abort()
  await aborted
  await first
  const alreadyAborted = new AbortController()
  alreadyAborted.abort()
  await assert.rejects(store.search(query('searchable'), { signal: alreadyAborted.signal }), { name: 'AbortError' })
  const pending = store.commit(row('keep'), docs(1))
  const close = store.close()
  await pending
  await close
  assert.equal(store.close(), close)
  await assert.rejects(store.stats(), { code: 'STORE_CLOSED' })
  const bad = open('different')
  await assert.rejects(bad.ready, /incompatible/)
  await assert.rejects(bad.stats(), /incompatible/)
  await bad.close().catch(() => {})
})

test('timeout removes queued search and abrupt worker death rejects pending requests', async t => {
  const { open } = await fixture(t)
  const store = open()
  // Worker startup is asynchronous; this deadline expires before dispatch.
  await assert.rejects(store.search(query('searchable'), { timeoutMs: 0 }), { code: 'QUERY_TIMEOUT' })
  await store.ready
  const pending = store.stats()
  const rejected = assert.rejects(pending, /worker exited/)
  await store.worker.terminate()
  await rejected
  await assert.rejects(store.stats(), /worker exited/)
})

test('canceling a dispatched query retains capacity until the worker completes it', async t => {
  const { open } = await fixture(t, { maxPending: 1 })
  const store = open()
  await store.ready
  const controller = new AbortController()
  const pending = store.search(query('searchable'), { signal: controller.signal })
  const rejected = assert.rejects(pending, { code: 'ABORT_ERR' })
  controller.abort()
  await assert.rejects(store.stats(), { code: 'QUEUE_FULL' })
  await rejected
  await store.close()
})

test('SIGKILL during a large cross-process commit leaves all or none of its documents', async t => {
  const { path, open } = await fixture(t)
  const store = open()
  await store.commit(row('keep'), docs(1))
  const writer = child(path, 'crash-write')
  t.after(() => { if (writer.process.exitCode === null) writer.process.kill() })
  await once(writer.process, 'message')
  writer.process.kill('SIGKILL')
  await writer.done
  const stats = await store.stats()
  assert.ok(stats.documents === 1 || stats.documents === 10001)
  const crashed = await store.sessionRow('crash-session')
  assert.equal(crashed?.doc_count ?? 0, stats.documents - 1)
  assert.equal((await store.search(query('atomic'))).totalHits, crashed ? 5000 : 0)
  await store.commit(row('after-crash'), docs(1))
  assert.equal((await store.stats()).documents, stats.documents + 1)
})

test('reader survives another process being killed and accepts later writes', async t => {
  const { path, open } = await fixture(t)
  const store = open()
  await store.commit(row('keep'), docs(1))
  const holder = child(path, 'hold')
  t.after(() => { if (holder.process.exitCode === null) holder.process.kill() })
  await once(holder.process, 'message')
  holder.process.kill('SIGKILL')
  await holder.done
  await store.commit(row('later'), docs(1))
  assert.equal((await store.stats()).documents, 2)
})
