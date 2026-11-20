import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

// Exercise the production adapter without exporting a test-only browser API.
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function fixture({ pages = [], nodes = [], ready, hasMore = true } = {}) {
  let create, entries = [{ event: { seq: 100 } }], nav = new AbortController(), released = 0, calls = 0, scrolls = 0, opened = []
  const events = new Map(), frames = [], notices = []
  const seat = { isConnected: true, parentElement: null, hasAttribute: () => false, getClientRects: () => [1], scrollIntoView: () => scrolls++, setAttribute() {}, focus() {}, addEventListener() {} }
  const projection = { subscribe: () => () => {}, getSnapshot: () => ({ nodes: { values: () => nodes } }) }
  const session = { getSnapshot: () => ({ openState: 'open', hasMore }), loadOlder: async () => {
    const page = pages[calls++]
    if (page instanceof Promise) entries = await page
    else if (page) entries = page
    else hasMore = false
  } }
  const binding = { session, eventSource: { getSnapshot: () => ({ entries }) } }
  const services = {
    uiWorkspace: { openSession: id => { opened.push(id); nav.abort(); nav = new AbortController() } },
    layout: { beginNavigation: () => { nav.abort(); nav = new AbortController(); return nav.signal } },
    sessions: { retain: () => ({ ready: ready || Promise.resolve(binding), release: () => released++ }) },
    uiConversation: { binding: () => ({ target: () => projection }) },
  }
  const context = { get: name => services[name] }
  const document = {
    addEventListener(type, fn) { const handlers = events.get(type) || new Set(); handlers.add(fn); events.set(type, handlers) },
    removeEventListener(type, fn) { events.get(type)?.delete(fn) },
    querySelector(selector) { assert.match(selector, /^\[data-chat-node-key="/); return seat },
  }
  vm.runInNewContext(source.replace('    function makePage(', '    globalThis.capture(makeNavigation)\n    function makePage('), {
    capture: value => create = value,
    window: { __ModuleLoader__: { load(spec) { spec.factory(() => ({})) } } },
    AbortController, AbortSignal, Event, document, CSS: { escape: value => value },
    requestAnimationFrame: fn => frames.push(fn),
  })
  const navigation = create(context)
  navigation.subscribe(() => notices.push(navigation.getSnapshot()))
  const flush = async () => { for (let i = 0; i < 15; i++) { await Promise.resolve(); frames.splice(0).forEach(fn => fn()) } }
  return { navigation, flush, notices, opened, services, binding, get calls() { return calls }, get scrolls() { return scrolls }, get released() { return released }, interrupt(type = 'wheel') { events.get(type)?.forEach(fn => fn()) }, changeSession() { services.uiWorkspace.openSession('elsewhere') } }
}
const event = seq => ({ event: { type: 'user/message', seq } })
const node = (seq, kind = 'user') => ({ key: `message-${seq}`, kind, data: { seq } })

test('cold history pages until exact durable message, releases reference and locates once', async () => {
  const f = fixture({ pages: [[event(60)], [event(10), event(60)]], nodes: [node(10)] })
  const done = f.navigation.open('cold', 10); await f.flush(); await done
  assert.equal(f.calls, 2); assert.equal(f.scrolls, 1); assert.equal(f.released, 1)
  assert.equal(f.navigation.getSnapshot().phase, 'done')
})
test('assistant final message identity is independent of live anchor', async () => {
  const f = fixture({ pages: [[event(5)]], nodes: [{ key: 'assistant', anchorSeq: 2, data: { finalNode: { seq: 5 } } }] })
  const done = f.navigation.open('assistant', 5); await f.flush(); await done
  assert.equal(f.scrolls, 1)
})
test('missing and deleted message fail explicitly rather than selecting a nearby message', async () => {
  const f = fixture({ pages: [[event(1), event(11)]], nodes: [node(11)] })
  await f.navigation.open('deleted', 10)
  assert.equal(f.scrolls, 0); assert.equal(f.navigation.getSnapshot().code, 'navigationMissing'); assert.equal(f.released, 1)
})
test('latest result wins even when old page settles after the new navigation', async () => {
  let settle
  const page = new Promise(resolve => settle = resolve)
  const f = fixture({ pages: [page], nodes: [node(100), node(10)] })
  const old = f.navigation.open('old', 10); await f.flush()
  const latest = f.navigation.open('new', 100); await f.flush(); await latest
  settle([event(10)]); await f.flush(); await old
  assert.equal(f.scrolls, 1); assert.equal(f.released, 2); assert.equal(f.navigation.getSnapshot().seq, 100)
})
test('switching sessions and explicit cancellation stop paging before another request or scroll', async () => {
  for (const cancel of [f => f.changeSession(), f => f.navigation.cancel(), f => f.interrupt()]) {
    let settle
    const page = new Promise(resolve => settle = resolve)
    const f = fixture({ pages: [page, [event(10)]], nodes: [node(10)] })
    const done = f.navigation.open('cancel', 10); await f.flush(); cancel(f)
    settle([event(60)]); await f.flush(); await done
    assert.equal(f.calls, 1); assert.equal(f.scrolls, 0); assert.equal(f.released, 1)
    assert.equal(f.navigation.getSnapshot().phase, 'idle')
  }
})
test('tool call and result resolve through durable identity rather than the row anchor', async () => {
  const f = fixture({ pages: [[{ event: { type: 'tool/call', seq: 5, data: { callId: 'call-1' } } }]],
    nodes: [{ key: 'tool', anchorSeq: 2, data: { root: { callId: 'call-1', seq: 9, subCalls: [] } } }] })
  const done = f.navigation.open('tool', 5); await f.flush(); await done
  assert.equal(f.scrolls, 1)
})
test('cancel while initial cold open waits releases immediately and ignores late readiness', async () => {
  let settle
  const f = fixture({ ready: new Promise(resolve => settle = resolve), nodes: [node(100)] })
  const done = f.navigation.open('cold', 100); f.navigation.cancel(); await f.flush(); await done
  settle(f.binding); await f.flush()
  assert.equal(f.released, 1); assert.equal(f.scrolls, 0); assert.equal(f.calls, 0)
})
test('unavailable public seam gives explicit feedback without DOM fallback', async () => {
  const f = fixture(); delete f.services.uiConversation
  await f.navigation.open('unsupported', 1)
  assert.equal(f.navigation.getSnapshot().code, 'navigationUnsupported'); assert.equal(f.scrolls, 0)
})
test('stalled history and bounded paging report failures', async () => {
  const stalled = fixture({ pages: [[event(100)]] })
  await stalled.navigation.open('stalled', 1)
  assert.equal(stalled.navigation.getSnapshot().code, 'navigationStalled')
  const bounded = fixture({ pages: Array.from({ length: 50 }, (_, n) => [event(99 - n)]) })
  await bounded.navigation.open('bounded', 1)
  assert.equal(bounded.calls, 40); assert.equal(bounded.navigation.getSnapshot().code, 'navigationLimit')
})
