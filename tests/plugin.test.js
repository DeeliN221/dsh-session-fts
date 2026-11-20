import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { AsyncFtsStore } from '../host/lexical.js'
import { Indexer } from '../host/indexer.js'

// Run the plugin's actual registrations with real worker storage; external DSH
// services provide only the deterministic source and route/tool registration.
test('plugin boot, search and disposal use the async SQLite store', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fts-plugin-'))
  const disposers = []
  let tool
  const ctx = {
    sessions: { get: () => undefined },
    sessionQuery: { listSessions: async () => [] },
    tools: { register(value) { tool = value; return () => { tool = undefined } } },
    get: () => undefined,
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    on: () => {}, inject: () => {},
  }
  t.after(async () => { for (const dispose of disposers.reverse()) await dispose(); rmSync(root, { recursive: true, force: true }) })
  await apply(ctx, { path: join(root, 'fts.sqlite'), sourceId: 'test-corpus', startupDelayMs: 600000, semantic: { enabled: false } })
  const output = await tool.execute({ query: '不存在', scope: 'all', days: 0 }, { agent: undefined })
  assert.match(output, /0 session/)
})

test('async indexer preserves other process data when local corpus is partial', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fts-partial-'))
  const store = new AsyncFtsStore(join(root, 'fts.sqlite'), 'test', { sourceId: 'same-complete-corpus' })
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }) })
  await store.ready
  await store.commit({ id: 'other-process', cwd: '/project', parent: null, origin: null, title: 'Other',
    created_at: 1, updated_at: 1, stamp: 'r1', indexed_seq: 1 }, [{ seq: 1, role: 'user', time: 1, text: 'shared document' }])
  const ctx = { sessions: { get: () => undefined }, sessionQuery: { listSessions: async () => [] }, get: () => undefined }
  const indexer = new Indexer(ctx, store, { liveDelayMs: 10, maxDocChars: 20000, tools: false })
  await indexer.reconcileAll()
  assert.equal((await store.stats()).documents, 1)
  await indexer.dispose()
})

test('async indexer consults persistence again before pruning a missing list item', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fts-prune-'))
  const store = new AsyncFtsStore(join(root, 'fts.sqlite'), 'test')
  t.after(async () => { await store.close(); rmSync(root, { recursive: true, force: true }) })
  await store.ready
  await store.commit({ id: 'a', cwd: '/p', parent: null, origin: null, title: 'A',
    created_at: 1, updated_at: 1, stamp: 'r', indexed_seq: 1 }, [])
  let present = true
  const persistence = { list: async () => [], stat: async () => present ? { header: { id: 'a' } } : undefined }
  const ctx = { sessions: { get: () => undefined }, sessionQuery: { listSessions: async () => [] }, get: () => persistence }
  const indexer = new Indexer(ctx, store, { liveDelayMs: 10, maxDocChars: 20000, tools: false })
  await indexer.reconcileAll()
  assert.deepEqual(await store.sessionIds(), ['a'])
  present = false
  await indexer.reconcileAll()
  assert.deepEqual(await store.sessionIds(), [])
  await store.commit({ id: 'foreign-live', cwd: '/p', parent: null, origin: null, title: 'Live',
    created_at: 1, updated_at: 1, stamp: 'live:1', indexed_seq: 1 }, [])
  await indexer.reconcileAll()
  assert.deepEqual(await store.sessionIds(), ['foreign-live'])
  await indexer.dispose()
})
