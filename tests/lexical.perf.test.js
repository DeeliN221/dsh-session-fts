import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { FtsStore } from '../host/store.js'
import { AsyncFtsStore } from '../host/lexical.js'
import { compileQuery } from '../host/text.js'

async function measure(task) {
  let ticks = 0
  let maxLagMs = 0
  let previous = performance.now()
  const timer = setInterval(() => {
    const now = performance.now()
    maxLagMs = Math.max(maxLagMs, now - previous - 2)
    previous = now
    ticks++
  }, 2)
  const start = performance.now()
  await task()
  const elapsedMs = performance.now() - start
  const duringTicks = ticks
  await new Promise(resolve => setTimeout(resolve, 5))
  clearInterval(timer)
  return { elapsedMs: Math.round(elapsedMs), maxLagMs: Math.round(maxLagMs), duringTicks }
}

test('lexical worker keeps host timers responsive; synchronous SQLite is the negative control', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-lexical-perf-'))
  const path = join(root, 'index.sqlite')
  const sync = new FtsStore(path, 'perf')
  let asyncStore
  t.after(async () => {
    sync.close()
    await asyncStore?.close().catch(() => {})
    await rm(root, { recursive: true, force: true })
  })
  const docs = Array.from({ length: 6000 }, (_, seq) => ({ seq, role: 'user', time: seq,
    text: `searchable corpus ${seq} ${'representative document content '.repeat(15)}` }))
  sync.commit({ id: 'perf', cwd: '/perf', parent: null, origin: null, title: 'performance', created_at: 1,
    updated_at: 6000, stamp: 'one', indexed_seq: 5999 }, docs)
  asyncStore = new AsyncFtsStore(path, 'perf', { cacheSize: 0 })
  await asyncStore.ready
  const q = { ...compileQuery('searchable'), limit: 20, offset: 0, sort: 'relevance' }
  const iterations = 20
  const blocking = await measure(async () => {
    for (let i = 0; i < iterations; i++) assert.equal(sync.search(q).totalHits, 5000)
  })
  const worker = await measure(async () => {
    for (let i = 0; i < iterations; i++) assert.equal((await asyncStore.search(q)).totalHits, 5000)
  })
  t.diagnostic(JSON.stringify({ documents: docs.length, iterations, blocking, worker }))
  assert.equal(blocking.duringTicks, 0)
  assert.ok(blocking.elapsedMs > 30, 'negative control must contain material blocking work')
  assert.ok(worker.duringTicks > 5, 'host timers must run while SQLite searches are executing')
  assert.ok(worker.maxLagMs < blocking.maxLagMs, 'offloading must reduce event-loop stall versus the same synchronous workload')
})
