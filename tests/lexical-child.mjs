import { AsyncFtsStore } from '../host/lexical.js'
const [path, mode, identity = 'corpus'] = process.argv.slice(2)
const store = new AsyncFtsStore(path, mode === 'mismatch' ? 'different' : 'shared', { sourceId: identity })
try {
  await store.ready
  if (mode === 'write') {
    for (let seq = 0; seq < 40; seq++) {
      await store.commit({ id: 'shared-session', cwd: '/test', parent: null, origin: null, title: `title ${seq}`,
        created_at: 1, updated_at: seq, stamp: `${seq}`, indexed_seq: seq },
      [{ seq, role: 'user', time: seq, text: 'concurrent searchable corpus' }])
    }
    process.send?.({ ok: true, stats: await store.stats() })
  } else if (mode === 'clear') {
    await store.clear()
    process.send?.({ ok: true })
  } else if (mode === 'crash-write') {
    const documents = Array.from({ length: 10000 }, (_, seq) => ({ seq, role: 'user', time: seq, text: 'atomic crash recovery '.repeat(20) }))
    const pending = store.commit({ id: 'crash-session', cwd: '/test', parent: null, origin: null, title: 'crash',
      created_at: 1, updated_at: 10000, stamp: 'one', indexed_seq: 9999 }, documents)
    process.send?.({ started: true })
    await pending
  } else if (mode === 'hold') {
    process.send?.({ ready: true })
    await new Promise(resolve => process.once('message', resolve))
  } else process.send?.({ ok: true, stats: await store.stats() })
} catch (error) {
  process.send?.({ error: error.message })
  process.exitCode = 1
} finally {
  await store.close().catch(() => {})
  process.disconnect?.()
}
