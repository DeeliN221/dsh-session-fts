/** Synthetic shipped-JS diagnostic: broad phrase, warm lookups, bounded retained cache. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { ResultCache } from '../host/cache.js'
const root = mkdtempSync(join(tmpdir(), 'dsh-search-perf-'))
try {
  let moduleUrl = new URL('../host/store.js', import.meta.url)
  if (process.argv.includes('--upstream')) {
    for (const file of ['store.js', 'text.js']) writeFileSync(join(root, file), execFileSync('git', ['show', `f35075dec304797fd500420f38dd078d44fb00bb:host/${file}`]))
    moduleUrl = pathToFileURL(join(root, 'store.js'))
  }
  const { FtsStore } = await import(moduleUrl)
  const { compileQuery } = await import('../host/text.js')
  const store = new FtsStore(join(root, 'index.sqlite'), 'perf')
  const beforeIndex = performance.now()
  for (let session = 0; session < 200; session++) {
    const id = `synthetic-${session}`
    store.commit({ id, cwd: '/synthetic', parent: null, origin: null, title: `性能方案 ${session}`,
      created_at: 1, updated_at: 100, stamp: 'r1', indexed_seq: 50 },
    Array.from({ length: 50 }, (_, seq) => ({ seq, role: seq % 2 ? 'assistant' : 'user', time: 100 + seq,
      text: `检索缓存方案 ${session} ${seq} ${'synthetic benchmark searchable content '.repeat(60)}` })))
  }
  const indexMs = performance.now() - beforeIndex
  const query = { ...compileQuery('缓存'), limit: 20, offset: 0, sort: 'relevance' }
  const samples = []
  for (let n = 0; n < 7; n++) {
    const start = performance.now()
    const page = store.search(query)
    samples.push(performance.now() - start)
    if (page.sessions.length !== 20) throw new Error('missing search results')
  }
  const cache = new ResultCache(64, 4 * 1024 * 1024)
  cache.set('q', 1, store.search(query))
  const cached = []
  for (let n = 0; n < 7; n++) { const start = performance.now(); cache.get('q', 1); cached.push(performance.now() - start) }
  global.gc?.()
  console.log(JSON.stringify({ mode: process.argv.includes('--upstream') ? 'upstream' : 'fork', node: process.version,
    platform: `${process.platform}/${process.arch}`, sessions: 200, documents: 10000,
    indexMs, searchMs: samples, cacheHitMs: cached, retainedHeapBytes: process.memoryUsage().heapUsed,
    peakRssBytes: process.resourceUsage().maxRSS * 1024, cacheBytes: cache.bytes }))
  store.close()
} finally { rmSync(root, { recursive: true, force: true }) }
