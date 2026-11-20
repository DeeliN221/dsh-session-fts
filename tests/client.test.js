import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
function harness(locale = 'en') {
  const hooks = [], pending = [], timers = new Map(), intervals = new Map(), requests = [], dicts = {}
  let cursor = 0, dirty = true, tree, Page, id = 0
  const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]))
  const React = {
    createElement(type, props, ...children) { return { type, props: props || {}, children: children.flat(Infinity) } }, Fragment: 'fragment',
    useState(initial) { const n = cursor++; if (!hooks[n]) { const slot = { value: initial }; slot.set = value => { const next = typeof value === 'function' ? value(slot.value) : value; if (!Object.is(next, slot.value)) {slot.value = next; dirty = true} }; hooks[n] = slot }; return [hooks[n].value, hooks[n].set] },
    useRef(current) { const n = cursor++; return hooks[n] ||= { current } },
    useCallback(fn, deps) { const n = cursor++; if (!same(hooks[n]?.deps, deps)) hooks[n] = { deps, fn }; return hooks[n].fn },
    useEffect(fn, deps) { const n = cursor++; if (!same(hooks[n]?.deps, deps)) { const previous = hooks[n]; hooks[n] = { deps }; pending.push(() => {previous?.cleanup?.(); hooks[n].cleanup = fn()}) } },
    useSyncExternalStore() {},
  }
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load(spec) { const plugin = spec.factory(() => React); plugin.apply({effect: fn => fn(), locale: {register: (_, lang, dict) => dicts[lang] = dict, bind: () => key => dicts[locale][key], subscribe() {}, getSnapshot() {}}, slots: {inject: (_, fn) => fn(), register(meta, component) { if (meta.name === 'main') Page = component }}}) } } }, URL, AbortController, document: { baseURI: 'https://example.test/base/' }, fetch(url, options) { return new Promise((resolve, reject) => requests.push({url, options, body: options.body && JSON.parse(options.body), resolve(value) {resolve({json: async () => ({ok: true, value})})}, reject})) }, setTimeout(fn) {const n = ++id; timers.set(n, fn); return n}, clearTimeout: n => timers.delete(n), setInterval(fn) {const n = ++id; intervals.set(n, fn); return n}, clearInterval: n => intervals.delete(n) })
  const render = () => {let count=0; while(dirty) {assert.ok(++count<20); dirty=false; cursor=0; tree=Page(); pending.splice(0).forEach(fn=>fn())}; return tree}
  const nodes = () => {render(); const result=[]; const walk = node => {if (node && typeof node==='object') {result.push(node); node.children?.forEach(walk)}}; walk(tree); return result}
  const text = node => typeof node === 'string' ? node : node?.children?.map(text).join('') || ''
  const button = label => nodes().find(node => node.type==='button' && (text(node)===label || (node.props.className === 'sfts-card-head sfts-hit' && text(node.children[0]) === label)))
  const input = () => nodes().find(node => node.type==='input' && node.props.type==='search')
  const flush = async () => {for(let n=0;n<8;n++) await Promise.resolve(); render()}
  render()
  return {requests, render, nodes, text, button, flush, type(value) {input().props.onChange({target:{value}}); render()}, tick() {const list=[...timers.values()]; timers.clear(); list.forEach(fn=>fn());render()}, poll() {intervals.forEach(fn=>fn());render()}, unmount() {hooks.forEach(slot=>slot.cleanup?.())}, timers, intervals}
}
const status = phase => ({sessions: 1, documents: 2, indexToolOutput: true, workspaces: [], semantic: {phase, indexed: 2, total: 4}})
const result = title => ({totalSessions: 2,totalHits: 2,sessions:[{sessionId:title,title,cwd:'/test',hits:1,lastMatchAt:Date.now(),matches:[]}]})
test('mode contract, retained results, immediate cancellation, late response and blank query', async () => {
  const app=harness(); app.requests[0].resolve(status('ready')); await app.flush()
  assert.equal(app.button('Full text').props['aria-pressed'], true)
  app.type('alpha'); assert.ok(app.nodes().some(n=>n.props.role==='status' && app.text(n)==='Searching…')); app.tick()
  const first=app.requests.at(-1); assert.equal(first.body.mode,'fulltext'); first.resolve(result('Alpha')); await app.flush()
  app.type('beta'); assert.equal(first.options.signal.aborted,true); app.tick(); const beta=app.requests.at(-1)
  beta.reject(new Error('offline')); await app.flush(); assert.ok(app.button('Alpha')); assert.ok(app.nodes().some(n=>n.props.role==='alert')); assert.equal(app.button('Load more'),undefined)
  app.button('Title').props.onClick(); app.render(); app.tick(); const title=app.requests.at(-1); assert.equal(title.body.mode,'title')
  app.button('Semantic').props.onClick(); assert.equal(title.options.signal.aborted,true); app.render(); title.resolve(result('Stale')); await app.flush(); assert.equal(app.button('Stale'),undefined)
  app.tick(); const semantic=app.requests.at(-1); assert.equal(semantic.body.mode,'semantic')
  app.type(' '); assert.equal(semantic.options.signal.aborted,true); assert.equal(app.button('Alpha'),undefined); app.tick(); assert.equal(app.requests.at(-1),semantic)
  app.unmount(); assert.equal(app.timers.size,0); assert.equal(app.intervals.size,0)
})
test('filter changes cancel during debounce; pagination and active mode no-op', async () => {
  const app=harness();app.requests[0].resolve(status('ready'));await app.flush();app.type('q');app.tick(); const first=app.requests.at(-1);first.resolve(result('Page one'));await app.flush()
  app.button('Full text').props.onClick();app.render();assert.equal(first.options.signal.aborted,false)
  app.button('Load more').props.onClick(); app.render();const page=app.requests.at(-1);assert.equal(page.body.offset,1);page.resolve({...result('Page two')});await app.flush();assert.ok(app.button('Page one'));assert.ok(app.button('Page two'))
  app.button('Today').props.onClick(); assert.equal(page.options.signal.aborted,true);app.render();app.tick();const filtered=app.requests.at(-1);assert.equal(typeof filtered.body.from,'number');app.unmount();assert.equal(filtered.options.signal.aborted,true)
})
test('localized semantic states, disabled configuration tooltip, polling abort and teardown', async () => {
  const app=harness('zh');const initial=app.requests[0];app.poll();assert.equal(initial.options.signal.aborted,true);initial.resolve(status('ready'));await app.flush();app.requests.at(-1).resolve(status('disabled'));await app.flush()
  assert.equal(app.button('语义').props.disabled,true);assert.ok(app.nodes().some(n=>n.props.title?.includes('配置嵌入模型')))
  for(const phase of ['loading','indexing','ready','error']) {app.poll();app.requests.at(-1).resolve({...status(phase),semantic:{...status(phase).semantic,error:'unavailable'}});await app.flush();assert.equal(app.button('语义').props.disabled,false);assert.ok(app.nodes().some(n=>n.props.role==='status' && app.text(n).includes(phase==='error'?'unavailable':phase==='loading'?'加载': '2/4')))}
  app.poll(); app.requests.at(-1).resolve(status('waiting')); await app.flush(); assert.ok(app.nodes().some(n=>n.props.role==='status' && app.text(n).includes('等待其他进程')))
  app.poll(); const pending=app.requests.at(-1);app.unmount();assert.equal(pending.options.signal.aborted,true);assert.equal(app.intervals.size,0);pending.resolve(status('disabled'));await app.flush()
})
