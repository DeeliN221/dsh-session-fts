window.__ModuleLoader__.load({
  id: 'dsh-session-fts',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useSyncExternalStore } = React
    const NS = 'session-fts'
    const PANEL = 'session-fts'
    const DAY = 86400000

    const DICT = {
      zh: {
        title: '会话搜索', placeholder: '搜索历史会话内容（空格分隔多个词，同时匹配）', search: '搜索',
        range: '时间', today: '今天', d7: '近 7 天', d30: '近 30 天', d90: '近 90 天', all: '全部', custom: '自定义',
        from: '从', to: '到', workspace: '工作区', allWorkspaces: '全部工作区', roles: '内容',
        user: '我', assistant: '助手', tool: '工具输出', sort: '排序', relevance: '相关度', recent: '最近',
        subagents: '包含子代理会话', results: '{sessions} 个会话 · {hits} 条消息', capped: '（结果较多，已截断）',
        none: '没有找到匹配内容。可以减少关键词或放宽时间范围。', more: '加载更多', untitled: '未命名会话',
        hits: '{n} 处', indexed: '已索引 {sessions} 个会话 · {docs} 条消息', indexing: '正在索引 {done}/{total}',
        reindex: '重新扫描', rebuild: '重建索引', error: '搜索失败：{msg}', hint: '输入关键词开始搜索。索引只保存在本机。',
        locating: '正在加载并定位消息… 已加载 {pages} 页历史', located: '已定位消息 #{seq}',
        navigationArchived: '此会话已归档。请先恢复，再打开此搜索结果。',
        restoreAndLocate: '恢复并定位', restoring: '正在恢复会话…', navigationRestoreFailed: '无法恢复此会话，请重试。',
        navigationUnsupported: '当前 DSH 无法精确定位这条消息。', navigationMissing: '消息不存在或已删除，请重新扫描索引。',
        navigationLimit: '历史过长，已停止自动加载。请在会话中加载更早消息后重试。', navigationStalled: '历史加载未能前进，请检查连接后重试。',
        navigationView: '无法显示目标消息，请切换到聊天视图后重试。', navigationTimeout: '定位超时，请重试。', navigationFailed: '无法打开目标消息，请检查连接后重试。',
        open: '打开会话', mode: '搜索方式', titleMode: '标题', fulltextMode: '全文', semanticMode: '语义',
        searching: '正在搜索…', semanticDisabled: '语义搜索未启用；请先配置嵌入模型。',
        semanticWaiting: '等待其他进程完成索引，已提交内容仍可查询',
        semanticLoading: '正在加载语义搜索…', semanticIndexing: '正在建立语义索引 {indexed}/{total}',
        semanticReady: '语义搜索就绪 · {indexed}/{total}', semanticError: '语义搜索出错：{msg}',
      },
      en: {
        title: 'Session search', placeholder: 'Search earlier sessions (space-separated terms must all match)', search: 'Search',
        range: 'Time', today: 'Today', d7: 'Last 7 days', d30: 'Last 30 days', d90: 'Last 90 days', all: 'All time', custom: 'Custom',
        from: 'From', to: 'To', workspace: 'Workspace', allWorkspaces: 'All workspaces', roles: 'Content',
        user: 'Me', assistant: 'Assistant', tool: 'Tool output', sort: 'Sort', relevance: 'Relevance', recent: 'Recent',
        subagents: 'Include subagent sessions', results: '{sessions} sessions · {hits} messages', capped: ' (capped)',
        none: 'No matches. Try fewer terms or a wider time range.', more: 'Load more', untitled: 'Untitled session',
        hits: '{n} hits', indexed: 'Indexed {sessions} sessions · {docs} messages', indexing: 'Indexing {done}/{total}',
        reindex: 'Rescan', rebuild: 'Rebuild index', error: 'Search failed: {msg}', hint: 'Type to search. The index stays on this machine.',
        locating: 'Loading and locating message… {pages} history pages loaded', located: 'Located message #{seq}',
        navigationArchived: 'This session is archived. Restore it before opening this search result.',
        restoreAndLocate: 'Restore and locate', restoring: 'Restoring session…', navigationRestoreFailed: 'Could not restore the session. Retry.',
        navigationUnsupported: 'This DSH version cannot locate this message precisely.', navigationMissing: 'Message is missing or deleted. Rescan the index.',
        navigationLimit: 'History loading limit reached. Load earlier messages in the conversation and retry.', navigationStalled: 'History loading made no progress. Check the connection and retry.',
        navigationView: 'Cannot display this message. Switch to the Chat view and retry.', navigationTimeout: 'Message navigation timed out. Retry.', navigationFailed: 'Cannot open this message. Check the connection and retry.',
        open: 'Open session', mode: 'Search mode', titleMode: 'Title', fulltextMode: 'Full text', semanticMode: 'Semantic',
        searching: 'Searching…', semanticDisabled: 'Semantic search is disabled; configure an embedding model to enable it.',
        semanticWaiting: 'Waiting for another process to finish indexing. Committed content is still searchable.',
        semanticLoading: 'Loading semantic search…', semanticIndexing: 'Indexing semantic search {indexed}/{total}',
        semanticReady: 'Semantic search ready · {indexed}/{total}', semanticError: 'Semantic search error: {msg}',
      },
    }
    const RANGES = [['today', 'today'], ['7', 'd7'], ['30', 'd30'], ['90', 'd90'], ['all', 'all'], ['custom', 'custom']]

    function apiUrl(action) {
      const base = typeof document !== 'undefined' && document.baseURI ? document.baseURI : location.href
      return new URL(`session-fts/api/${action}`, base).toString()
    }
    async function api(action, body, signal) {
      const response = await fetch(apiUrl(action), body === undefined
        ? { method: 'GET', credentials: 'same-origin', signal }
        : { method: 'POST', credentials: 'same-origin', signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!json.ok) throw new Error(json.error || `HTTP ${response.status}`)
      return json.value
    }
    function fmt(template, values) {
      return String(template).replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''))
    }
    function pad(n) { return String(n).padStart(2, '0') }
    function fmtTime(ms) {
      const d = new Date(ms)
      const sameYear = d.getFullYear() === new Date().getFullYear()
      return `${sameYear ? '' : d.getFullYear() + '-'}${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }
    function baseName(path) {
      if (!path) return '-'
      const parts = String(path).split(/[\\/]/).filter(Boolean)
      return parts[parts.length - 1] || path
    }
    function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
    function Highlight({ text, terms }) {
      const usable = terms.filter(Boolean)
      if (usable.length === 0) return text
      const re = new RegExp(`(${usable.map(escapeRegExp).join('|')})`, 'gi')
      return h(React.Fragment, null, String(text).split(re).map((part, i) => (i % 2 === 1 ? h('mark', { key: i, className: 'sfts-mark' }, part) : part)))
    }
    function rangeBounds(range, customFrom, customTo) {
      if (range === 'all') return {}
      if (range === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return { from: d.getTime() } }
      if (range === 'custom') return { from: customFrom || undefined, to: customTo || undefined }
      return { from: Date.now() - Number(range) * DAY }
    }

    function SearchIcon(props) {
      const size = typeof props.size === 'number' ? props.size : 16
      return h('svg', { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('path', { d: 'M4 5h7M4 9h5M4 13h4' }),
        h('circle', { cx: 15, cy: 13, r: 5 }),
        h('path', { d: 'm19 17 3 3' }))
    }

    const CSS = `
/* Keep layout local to the panel: split panes can be narrower than the viewport. */
.sfts-page{height:100%;overflow:auto;container:sfts / inline-size;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.sfts-page *{box-sizing:border-box}
.sfts-inner{max-width:880px;margin:0 auto;padding:16px 12px 32px;display:flex;flex-direction:column;gap:12px}
.sfts-title{font-size:20px;font-weight:500;margin:0}
.sfts-bar{display:flex;gap:8px;align-items:stretch}
.sfts-input{flex:1 1 0;min-width:0;min-height:44px;padding:8px 12px;border-radius:8px;border:1px solid var(--dsw-alias-label-secondary);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:16px;caret-color:currentColor}
.sfts-input::placeholder{color:var(--dsw-alias-label-secondary);opacity:1}
.sfts-btn{min-height:36px;padding:6px 12px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.sfts-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,var(--dsw-alias-bg-base));min-width:64px}
.sfts-btn.small{min-height:32px;padding:4px 8px;font-size:12px;background:transparent}
.sfts-btn:disabled,.sfts-chip:disabled{opacity:.5;cursor:not-allowed}
.sfts-page :is(button,input,select,summary):focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
.sfts-modes{display:flex;align-items:center;flex-wrap:wrap;gap:4px;font-size:13px}
.sfts-modes>span:first-child{margin-inline-end:6px;color:var(--dsw-alias-label-secondary)}
.sfts-feedback{font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sfts-feedback:empty{display:none}
.sfts-filters{display:flex;flex-wrap:wrap;gap:4px 16px;align-items:center;font-size:13px;color:var(--dsw-alias-label-secondary);padding-block:8px;border-block:1px solid var(--dsw-alias-border-l2)}
.sfts-group{display:flex;align-items:center;gap:6px;min-width:0;max-width:100%;flex-wrap:wrap}
.sfts-group>span:first-child{white-space:nowrap}
.sfts-chip{min-height:32px;min-width:32px;padding:5px 10px;border-radius:5px;border:1px solid transparent;background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;cursor:pointer}
.sfts-chip[aria-pressed="true"]{color:var(--dsw-alias-label-primary);font-weight:600;
  background:color-mix(in srgb,var(--dsw-alias-label-primary) 10%,transparent)}
.sfts-select,.sfts-date{min-height:32px;min-width:0;border-radius:5px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;padding:4px 6px;max-width:min(240px,100%)}
.sfts-check{display:flex;align-items:center;gap:6px;cursor:pointer;min-height:32px}
.sfts-check input{accent-color:var(--dsw-alias-state-business-primary)}
.sfts-meta{display:flex;flex-direction:column;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sfts-meta>span:empty{display:none}
.sfts-index summary{cursor:pointer;min-height:32px;padding-block:6px;line-height:20px;overflow-wrap:anywhere}
.sfts-index[open] summary{margin-block-end:4px}
.sfts-meta-actions{display:flex;flex-wrap:wrap;gap:6px;margin-block-start:6px}
@media(hover:hover){.sfts-btn:not(.primary):hover:not(:disabled),.sfts-chip:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}}
.sfts-list{display:flex;flex-direction:column;gap:10px}
.sfts-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;
  cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%}
.sfts-card:hover{border-color:var(--dsw-alias-border-l2)}
.sfts-hit{border:0;background:transparent;color:inherit;text-align:left;font:inherit;width:100%;cursor:pointer;padding:4px;border-radius:4px}
.sfts-hit:hover{background:var(--dsw-alias-bg-layer-2)}
.sfts-card-head{display:flex;justify-content:space-between;gap:12px;align-items:baseline}
.sfts-card-title{min-width:0;font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sfts-card-sub{font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;flex-shrink:0}
.sfts-match{margin-top:8px;font-size:13px;line-height:1.55;display:flex;gap:8px}
.sfts-role{flex-shrink:0;font-size:11px;padding:1px 6px;border-radius:4px;height:fit-content;margin-top:2px;
  border:1px solid var(--dsw-alias-border-l1);color:var(--dsw-alias-label-secondary)}
.sfts-snippet{word-break:break-word;color:var(--dsw-alias-label-primary)}
.sfts-time{color:var(--dsw-alias-label-secondary);font-size:11px;margin-left:6px}
.sfts-mark{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 35%,transparent);color:inherit;border-radius:2px;padding:0 1px}
.sfts-empty{padding:32px 0;text-align:center;color:var(--dsw-alias-label-secondary);font-size:13px}
.sfts-error{color:var(--dsw-alias-state-error-primary);font-size:13px;overflow-wrap:anywhere}
.sfts-card-head{flex-wrap:wrap;gap:4px}
.sfts-card-sub{white-space:normal;overflow-wrap:anywhere;flex-shrink:1}
@container sfts (min-width:600px){
  .sfts-inner{padding:24px 24px 48px}
  .sfts-card-head{flex-wrap:nowrap;gap:12px}
}
@media(pointer:coarse){
  .sfts-btn,.sfts-chip,.sfts-select,.sfts-date,.sfts-check,.sfts-index summary{min-height:44px}
  .sfts-chip{min-width:44px}
  .sfts-select,.sfts-date{font-size:16px}
}

`

    // Public Controllers own history and projections. This adapter only bridges the
    // missing public Chat reveal API to the exact stable node seat (never text scanning).
    function makeNavigation(ctx) {
      let current = null
      let snapshot = { phase: 'idle' }
      const listeners = new Set()
      const publish = value => { snapshot = value; listeners.forEach(fn => fn()) }
      const cancel = () => { current?.abort(); current = null; publish({ phase: 'idle' }) }
      const failure = code => Object.assign(new Error(code), { code })
      const wait = (promise, signal) => new Promise((resolve, reject) => {
        const aborted = () => { cleanup(); reject(signal.reason) }
        const cleanup = () => signal.removeEventListener('abort', aborted)
        if (signal.aborted) { reject(signal.reason); return }
        signal.addEventListener('abort', aborted, { once: true })
        Promise.resolve(promise).then(value => { cleanup(); resolve(value) }, error => { cleanup(); reject(error) })
      })
      const frame = signal => wait(new Promise(resolve => requestAnimationFrame(resolve)), signal)
      const waitForPager = (session, signal) => new Promise((resolve, reject) => {
        let stop = () => {}, settled = false
        const finish = error => {
          if (settled) return
          settled = true
          stop()
          signal.removeEventListener('abort', aborted)
          if (error) reject(error)
          else resolve()
        }
        const aborted = () => finish(signal.reason)
        const check = () => {
          if (signal.aborted) aborted()
          else if (!session.getSnapshot().loadingOlder) finish()
        }
        signal.addEventListener('abort', aborted, { once: true })
        stop = session.subscribe(check)
        if (settled) stop()
        check()
      })
      const stableSeat = async (seat, signal) => {
        let previous, stable = 0
        for (let attempt = 0; attempt < 90; attempt++) {
          await frame(signal)
          signal.throwIfAborted()
          if (!seat.isConnected) throw failure('navigationView')
          let blocked = false
          for (let ancestor = seat; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.hasAttribute('hidden') || ['reveal', 'collapse'].includes(ancestor.dataset?.chatMotion)) blocked = true
          }
          const rect = seat.getBoundingClientRect()
          const geometry = [rect.x, rect.y, rect.width, rect.height]
          const visible = !blocked && rect.width > 0 && rect.height > 0 && seat.getClientRects().length > 0
          stable = visible && previous?.every((value, index) => Math.abs(value - geometry[index]) < 0.5) ? stable + 1 : 0
          previous = visible ? geometry : undefined
          if (stable >= 3) return
        }
        throw failure('navigationView')
      }
      const open = async (sessionId, seq) => {
        cancel()
        const controller = new AbortController()
        current = controller
        let reference, stopProjection = () => {}, stopInput = () => {}
        try {
          const ui = ctx.get('uiWorkspace')
          if (!ui?.openSession) throw failure('navigationUnsupported')
          const archived = ctx.get('workspaces')?.list?.getSnapshot().archivedSessionIds
          if (archived?.includes(sessionId)) { publish({ phase: 'archived', sessionId, seq }); return }
          if (seq === undefined) { ui.openSession(sessionId); return }
          if (!Number.isSafeInteger(seq) || seq < 0) throw failure('navigationMissing')
          const sessions = ctx.get('sessions')
          const conversation = ctx.get('uiConversation')
          const layout = ctx.get('layout')
          if (!sessions?.retain || !conversation?.binding || !layout?.beginNavigation) throw failure('navigationUnsupported')
          ui.openSession(sessionId)
          // openSession itself advances layout navigation; acquire our guard afterwards.
          const signal = AbortSignal.any([controller.signal, layout.beginNavigation(), AbortSignal.timeout(120000)])
          const interrupted = () => controller.abort()
          for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) document.addEventListener(type, interrupted, { passive: true })
          stopInput = () => { for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) document.removeEventListener(type, interrupted) }
          publish({ phase: 'loading', seq, pages: 0 })
          reference = sessions.retain(sessionId, { source: 'controllerOperation', signal })
          const binding = await wait(reference.ready, signal)
          const session = binding.session
          const projection = conversation.binding(binding).target('chat')
          stopProjection = projection.subscribe(() => {})
          let event
          // loadOlder has a bounded page size. Never use the unbounded shared
          // loadThrough loop: a superseded search must not keep paging a cold log.
          for (let page = 0; ; ) {
            signal.throwIfAborted()
            const entries = binding.eventSource.getSnapshot().entries
            event = entries.find(entry => entry.event.seq === seq)?.event
            if (event) break
            if (session.getSnapshot().openState !== 'open') throw failure('navigationMissing')
            const head = entries[0]?.event.seq
            if (!session.getSnapshot().hasMore || (head !== undefined && head <= seq)) throw failure('navigationMissing')
            if (session.getSnapshot().loadingOlder) {
              await waitForPager(session, signal)
              continue
            }
            if (page >= 40) throw failure('navigationLimit')
            page++
            await wait(session.loadOlder(), signal)
            await waitForPager(session, signal)
            signal.throwIfAborted()
            const nextHead = binding.eventSource.getSnapshot().entries[0]?.event.seq
            if (nextHead === head) throw failure('navigationStalled')
            publish({ phase: 'loading', seq, pages: page })
          }
          signal.throwIfAborted()
          // Settled Assistant and Tool rows can anchor before their indexed event.
          // Resolve durable payload seq, never nearest seq/turn or snippet equality.
          const toolContains = root => root?.seq === seq
            || (event.type === 'tool/call' && root?.callId === String(event.data.callId))
            || root?.subCalls?.some(toolContains)
          let node
          for (let attempt = 0; attempt < 60; attempt++) {
            signal.throwIfAborted()
            node = projection.getSnapshot()?.nodes.values().find(candidate => {
              const data = candidate.data
              return data?.seq === seq || data?.finalNode?.seq === seq || toolContains(data?.root)
            })
            if (node) break
            await frame(signal)
          }
          if (!node) throw failure('navigationUnsupported')
          let seat
          for (let attempt = 0; attempt < 60; attempt++) {
            signal.throwIfAborted()
            seat = document.querySelector(`[data-chat-node-key="${globalThis.CSS.escape(node.key)}"]:not([data-chat-group-part="reasoning"])`)
            if (seat) break
            await frame(signal)
          }
          if (!seat) throw failure('navigationView')
          // DSH supports beforematch on folded ancestors. Ask their owners to
          // reveal state instead of mutating React-owned hidden attributes.
          for (let ancestor = seat; ancestor; ancestor = ancestor.parentElement) {
            if (ancestor.hasAttribute('hidden')) ancestor.dispatchEvent(new Event('beforematch'))
          }
          await stableSeat(seat, signal)
          seat.scrollIntoView({ block: 'center', behavior: 'instant' })
          seat.setAttribute('tabindex', '-1')
          seat.focus({ preventScroll: true })
          seat.addEventListener('blur', () => seat.removeAttribute('tabindex'), { once: true })
          // Opening Chat and fold owners may still reconcile their viewport.
          // Declare success only once the landing itself has stopped moving.
          await stableSeat(seat, signal)
          const viewport = seat.closest('[data-conversation-scroll]') || seat.closest('[data-chat-following-tail]')
          const target = seat.getBoundingClientRect()
          const bounds = viewport?.getBoundingClientRect()
          if (bounds && (target.bottom <= bounds.top || target.top >= bounds.bottom)) throw failure('navigationView')
          publish({ phase: 'done', seq })
        } catch (error) {
          if (current !== controller) return
          if (controller.signal.aborted || error?.name === 'AbortError') publish({ phase: 'idle' })
          else publish({ phase: 'error', code: error?.name === 'TimeoutError' ? 'navigationTimeout' : error?.code || 'navigationFailed' })
        } finally {
          stopProjection()
          stopInput()
          reference?.release()
          if (current === controller) current = null
        }
      }
      const canRestore = () => typeof ctx.get('uiWorkspace')?.unarchiveSession === 'function'
      const restore = async () => {
        if (snapshot.phase !== 'archived' || !canRestore()) return
        const target = snapshot
        cancel()
        const controller = new AbortController()
        current = controller
        const signal = AbortSignal.any([controller.signal, ctx.get('layout')?.beginNavigation?.() || controller.signal, AbortSignal.timeout(120000)])
        publish({ ...target, phase: 'restoring' })
        try {
          await wait(ctx.get('uiWorkspace').unarchiveSession(target.sessionId), signal)
          signal.throwIfAborted()
          if (current === controller) await open(target.sessionId, target.seq)
        } catch (error) {
          if (current === controller) publish(controller.signal.aborted || error?.name === 'AbortError'
            ? { phase: 'idle' } : { ...target, code: 'navigationRestoreFailed' })
        } finally {
          if (current === controller) current = null
        }
      }
      return { open, cancel, restore, canRestore, subscribe: fn => { listeners.add(fn); return () => listeners.delete(fn) }, getSnapshot: () => snapshot }
    }

    function makePage({ useT, openSession, cancelNavigation }) {
      return function SessionFtsPage() {
        const t = useT()
        const [query, setQuery] = useState('')
        const [mode, setMode] = useState('fulltext')
        const [range, setRange] = useState('30')
        const [customFrom, setCustomFrom] = useState('')
        const [customTo, setCustomTo] = useState('')
        const [cwd, setCwd] = useState('')
        const [roles, setRoles] = useState({ user: true, assistant: true, tool: true })
        const [sort, setSort] = useState('relevance')
        const [subagents, setSubagents] = useState(false)
        const [state, setState] = useState({ status: 'idle', value: null, error: null })
        const [status, setStatus] = useState(null)
        const inputRef = useRef(null)
        const abortRef = useRef(null)
        const debounceRef = useRef(null)
        const statusAbortRef = useRef(null)
        const mountedRef = useRef(false)
        const searchKey = JSON.stringify([query.trim(), mode, range, customFrom, customTo, cwd, roles, sort, subagents])

        const loadStatus = useCallback(() => {
          if (!mountedRef.current) return
          statusAbortRef.current?.abort()
          const controller = new AbortController()
          statusAbortRef.current = controller
          api('status', undefined, controller.signal).then(value => {
            if (!controller.signal.aborted) setStatus(value)
          }).catch(() => {})
        }, [])
        useEffect(() => {
          mountedRef.current = true
          loadStatus()
          inputRef.current?.focus()
          const timer = setInterval(loadStatus, 4000)
          return () => {
            mountedRef.current = false
            clearInterval(timer)
            statusAbortRef.current?.abort()
          }
        }, [loadStatus])

        // Cancel in the event handler, before React renders or the debounce elapses.
        const change = (setter, next) => {
          const current = new Map([[setQuery, query], [setMode, mode], [setRange, range],
            [setCustomFrom, customFrom], [setCustomTo, customTo], [setCwd, cwd],
            [setRoles, roles], [setSort, sort], [setSubagents, subagents]]).get(setter)
          if (Object.is(current, next)) return
          cancelNavigation()
          abortRef.current?.abort()
          clearTimeout(debounceRef.current)
          setter(next)
          setState(prev => setter === setQuery && !String(next).trim()
            ? { status: 'idle', value: null, error: null }
            : { ...prev, status: 'loading', error: null })
        }
        const run = useCallback((offset) => {
          clearTimeout(debounceRef.current)
          abortRef.current?.abort()
          const q = query.trim()
          if (q === '') { setState({ status: 'idle', value: null, error: null }); return }
          const controller = new AbortController()
          abortRef.current = controller
          const selectedRoles = Object.entries(roles).filter(([, on]) => on).map(([role]) => role)
          const body = {
            query: q, mode, ...rangeBounds(range, customFrom, customTo), cwd: cwd || undefined, sort,
            roles: selectedRoles.length === 3 ? undefined : selectedRoles, includeSubagents: subagents, limit: 20, offset,
          }
          setState(prev => ({ ...prev, status: 'loading', error: null }))
          api('search', body, controller.signal).then((value) => {
            if (controller.signal.aborted) return
            setState(prev => ({
              status: 'done', error: null, key: searchKey,
              value: offset > 0 && prev.key === searchKey && prev.value
                ? { ...value, sessions: [...prev.value.sessions, ...value.sessions] } : value,
            }))
          }).catch((error) => {
            if (controller.signal.aborted) return
            setState(prev => ({ ...prev, status: 'error', error: String(error?.message ?? error) }))
          })
        }, [query, mode, range, customFrom, customTo, cwd, roles, sort, subagents, searchKey])

        // Cleanup also covers changes triggered outside input events and unmounting.
        useEffect(() => {
          if (!query.trim()) run(0)
          else debounceRef.current = setTimeout(() => run(0), 300)
          return () => {
            clearTimeout(debounceRef.current)
            abortRef.current?.abort()
          }
        }, [run])
        useEffect(() => {
          if (mode === 'semantic' && status?.semantic?.phase === 'disabled') change(setMode, 'fulltext')
        }, [mode, status?.semantic?.phase])

        const terms = query.trim().split(/\s+/).filter(Boolean)
        const value = state.value
        const indexing = status?.indexing?.phase === 'indexing'
        const semantic = status?.semantic
        const semanticText = semantic?.phase === 'disabled' ? t('semanticDisabled')
          : semantic?.phase === 'waiting' ? t('semanticWaiting')
          : semantic?.phase === 'error' ? fmt(t('semanticError'), { msg: semantic.error || t('semanticMode') })
          : semantic?.phase === 'ready' || semantic?.phase === 'indexing'
            ? fmt(t(semantic.phase === 'ready' ? 'semanticReady' : 'semanticIndexing'), { indexed: semantic.indexed, total: semantic.total })
            : t('semanticLoading')
        const toggleRole = role => {
          const next = { ...roles, [role]: !roles[role] }
          if (Object.values(next).some(Boolean)) change(setRoles, next)
        }
        const roleOptions = status?.indexToolOutput ? ['user', 'assistant', 'tool'] : ['user', 'assistant']

        return h('div', { className: 'sfts-page' },
          h('style', null, CSS),
          h('div', { className: 'sfts-inner' },
            h('h1', { className: 'sfts-title' }, t('title')),
            h('form', { className: 'sfts-bar', role: 'search', onSubmit: (e) => { e.preventDefault(); run(0) } },
              h('input', {
                ref: inputRef, className: 'sfts-input', type: 'search', value: query, placeholder: t('placeholder'),
                'aria-label': t('title'), name: 'query', autoCorrect: 'off', autoCapitalize: 'none', spellCheck: false,
                onChange: e => change(setQuery, e.target.value),
              }),
              h('button', { type: 'submit', className: 'sfts-btn primary' }, t('search'))),
            h('div', { className: 'sfts-modes', role: 'group', 'aria-label': t('mode') },
              h('span', null, t('mode')),
              ['title', 'fulltext', 'semantic'].map(id => h('span', { key: id, title: id === 'semantic' && semantic?.phase === 'disabled' ? t('semanticDisabled') : undefined },
                h('button', { type: 'button', className: 'sfts-chip', 'aria-pressed': mode === id,
                  disabled: id === 'semantic' && semantic?.phase === 'disabled',
                  onClick: () => change(setMode, id) }, t(`${id}Mode`))))),
            mode === 'semantic' || semantic?.phase === 'error'
              ? h('div', { className: semantic?.phase === 'error' ? 'sfts-error' : 'sfts-feedback', role: 'status', 'aria-live': 'polite' }, semanticText) : null,
            h('div', { className: 'sfts-filters' },
              h('div', { className: 'sfts-group', role: 'group', 'aria-label': t('range') },
                h('span', null, t('range')),
                h('select', { className: 'sfts-select', 'aria-label': t('range'), value: range, onChange: e => change(setRange, e.target.value) },
                  RANGES.map(([id, key]) => h('option', { key: id, value: id }, t(key)))),
                range === 'custom' ? h(React.Fragment, null,
                  h('input', { type: 'date', className: 'sfts-date', 'aria-label': t('from'), value: customFrom, onChange: e => change(setCustomFrom, e.target.value) }),
                  h('span', null, '–'),
                  h('input', { type: 'date', className: 'sfts-date', 'aria-label': t('to'), value: customTo, onChange: e => change(setCustomTo, e.target.value) })) : null),
              h('div', { className: 'sfts-group' },
                h('span', null, t('workspace')),
                h('select', { className: 'sfts-select', value: cwd, onChange: e => change(setCwd, e.target.value), 'aria-label': t('workspace') },
                  h('option', { value: '' }, t('allWorkspaces')),
                  (status?.workspaces ?? []).map(w => h('option', { key: w.cwd, value: w.cwd, title: w.cwd }, `${baseName(w.cwd)} (${w.sessions})`)))),
              h('div', { className: 'sfts-group', role: 'group', 'aria-label': t('roles') },
                h('span', null, t('roles')),
                roleOptions.map(role => h('button', {
                  key: role, type: 'button', className: 'sfts-chip', 'aria-pressed': roles[role], onClick: () => toggleRole(role),
                }, t(role)))),
              h('div', { className: 'sfts-group' },
                h('span', null, t('sort')),
                h('select', { className: 'sfts-select', 'aria-label': t('sort'), value: sort, onChange: e => change(setSort, e.target.value) },
                  ['relevance', 'recent'].map(id => h('option', { key: id, value: id }, t(id))))),
              h('label', { className: 'sfts-check' },
                h('input', { type: 'checkbox', checked: subagents, onChange: e => change(setSubagents, e.target.checked) }), t('subagents'))),
            h('div', { className: 'sfts-meta' },
              h('span', null,
                value ? fmt(t('results'), { sessions: value.totalSessions, hits: value.totalHits }) + (value.truncated ? t('capped') : '') : ''),
              h('details', { className: 'sfts-index' },
                h('summary', null,
                status ? (indexing
                  ? fmt(t('indexing'), { done: status.indexing.done, total: status.indexing.total })
                  : fmt(t('indexed'), { sessions: status.sessions, docs: status.documents })) : t('semanticLoading')),
                h('div', { className: 'sfts-feedback', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, semanticText),
              h('span', { className: 'sfts-meta-actions' },
                h('button', { type: 'button', className: 'sfts-btn small', onClick: () => api('reindex', {}).then(loadStatus).catch(() => {}) }, t('reindex')),
                h('button', { type: 'button', className: 'sfts-btn small', onClick: () => api('reindex', { full: true }).then(loadStatus).catch(() => {}) }, t('rebuild'))))),
            h('div', { className: 'sfts-feedback', role: 'status', 'aria-live': 'polite' }, state.status === 'loading' ? t('searching') : ''),
            state.status === 'error' ? h('div', { className: 'sfts-error', role: 'alert' }, fmt(t('error'), { msg: state.error })) : null,
            !value && state.status !== 'loading' && state.status !== 'error' ? h('div', { className: 'sfts-empty' }, t('hint')) : null,
            value && value.sessions.length === 0 ? h('div', { className: 'sfts-empty' }, t('none')) : null,
            value ? h('div', { className: 'sfts-list' },
              value.sessions.map(session => h('article', { key: session.sessionId, className: 'sfts-card' },
              h('button', { type: 'button', className: 'sfts-card-head sfts-hit', title: t('open'),
                onClick: () => openSession(session.sessionId) },
                h('span', { className: 'sfts-card-title' }, session.title || t('untitled')),
                h('span', { className: 'sfts-card-sub' },
                  `${baseName(session.cwd)} · ${fmt(t('hits'), { n: session.hits })} · ${fmtTime(session.lastMatchAt)}`)),
              session.matches.map(match => h('button', { key: match.seq, type: 'button', className: 'sfts-match sfts-hit',
                onClick: () => openSession(session.sessionId, match.seq),
                'aria-label': `${t('open')} · ${t(match.role)} · ${fmtTime(match.time)} · #${match.seq}` },
                h('span', { className: 'sfts-role' }, t(match.role)),
                h('span', { className: 'sfts-snippet' },
                  h(Highlight, { text: match.snippet, terms }),
                  h('span', { className: 'sfts-time' }, fmtTime(match.time)))))))) : null,
            value && state.key === searchKey && value.sessions.length < value.totalSessions ? h('button', {
              type: 'button', className: 'sfts-btn', onClick: () => run(value.sessions.length), disabled: state.status === 'loading',
            }, t('more')) : null))
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        for (const [locale, dict] of Object.entries(DICT)) ctx.effect(() => ctx.locale.register(NS, locale, dict), `session-fts: ${locale}`)
        const t = ctx.locale.bind(NS)
        const subscribeLocale = fn => ctx.locale.subscribe(fn)
        const localeSnapshot = () => ctx.locale.getSnapshot()
        function useT() { useSyncExternalStore(subscribeLocale, localeSnapshot); return t }
        const navigation = makeNavigation(ctx)
        ctx.effect(() => () => navigation.cancel(), 'session-fts: navigation lifetime')
        function NavigationNotice() {
          const translate = useT()
          const state = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot)
          if (!state || state.phase === 'idle') return null
          const message = state.phase === 'loading' ? fmt(translate('locating'), { pages: state.pages ?? 0 })
            : state.phase === 'restoring' ? translate('restoring')
            : state.phase === 'archived' ? translate(state.code || 'navigationArchived')
            : state.phase === 'error' ? translate(state.code) : fmt(translate('located'), { seq: state.seq })
          return h('div', { role: state.phase === 'error' || state.code ? 'alert' : 'status', 'aria-live': 'polite',
            style: { pointerEvents: 'none', position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', maxWidth: 'min(90vw, 560px)', padding: '10px 14px', borderRadius: 8,
              background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l2)', fontSize: 13 } },
            message,
            state.phase === 'archived' && navigation.canRestore() ? h('button', { type: 'button', onClick: navigation.restore,
              style: { pointerEvents: 'auto', marginLeft: 12, padding: '6px 10px', font: 'inherit', color: 'inherit', cursor: 'pointer', borderRadius: 4,
                border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-2)' } }, translate('restoreAndLocate')) : null)
        }
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-fts-navigation', locale: NS }, NavigationNotice))
        const Page = makePage({ useT, openSession: navigation.open, cancelNavigation: navigation.cancel })
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, Page))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL, order: 30, label: () => t('title'), locale: NS,
        }, SearchIcon))
      },
    }
  },
})
