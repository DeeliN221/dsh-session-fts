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
        open: '打开会话', mode: '搜索方式', titleMode: '标题', fulltextMode: '全文', semanticMode: '语义',
        searching: '正在搜索…', semanticDisabled: '语义搜索未启用；请先配置嵌入模型。',
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
        open: 'Open session', mode: 'Search mode', titleMode: 'Title', fulltextMode: 'Full text', semanticMode: 'Semantic',
        searching: 'Searching…', semanticDisabled: 'Semantic search is disabled; configure an embedding model to enable it.',
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
.sfts-page{height:100%;overflow:auto;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base)}
.sfts-inner{max-width:880px;margin:0 auto;padding:28px 24px 48px;display:flex;flex-direction:column;gap:14px}
.sfts-title{font-size:20px;font-weight:500;margin:0}
.sfts-bar{display:flex;flex-wrap:wrap;gap:8px}
.sfts-bar .sfts-input{flex-basis:180px}
.sfts-input{flex:1;min-width:0;height:36px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:16px}
.sfts-input:focus{border-color:var(--dsw-alias-brand-primary)}
.sfts-btn{height:36px;padding:0 14px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap}
.sfts-btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2)}
.sfts-btn.primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:#fff}
.sfts-btn.small{height:26px;padding:0 10px;font-size:12px}
.sfts-btn:disabled,.sfts-chip:disabled{opacity:.5;cursor:not-allowed}
.sfts-page :is(button,input,select):focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.sfts-modes{display:flex;align-items:center;flex-wrap:wrap;gap:8px;font-size:13px}
.sfts-modes .sfts-chip[aria-pressed="true"]{font-weight:500;border-width:2px}
.sfts-feedback{font-size:13px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}
.sfts-filters{display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;font-size:13px;color:var(--dsw-alias-label-secondary)}
.sfts-group{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.sfts-chip{height:26px;padding:0 10px;border-radius:13px;border:1px solid var(--dsw-alias-border-l1);background:transparent;
  color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.sfts-chip[aria-pressed="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);
  background:color-mix(in srgb,var(--dsw-alias-brand-primary) 10%,transparent)}
.sfts-select,.sfts-date{height:26px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);
  color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px;max-width:240px}
.sfts-check{display:flex;align-items:center;gap:4px;cursor:pointer}
.sfts-meta{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.sfts-meta-actions{display:flex;flex-wrap:wrap;gap:6px}
.sfts-list{display:flex;flex-direction:column;gap:10px}
.sfts-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px 14px;
  cursor:pointer;text-align:left;font:inherit;color:inherit;width:100%}
.sfts-card:hover,.sfts-card:focus-visible{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
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
@media(max-width:480px){
  .sfts-inner{padding:20px 12px 32px}
  .sfts-card-head{flex-wrap:wrap;gap:4px}
  .sfts-card-sub{white-space:normal;overflow-wrap:anywhere;flex-shrink:1}
  .sfts-select,.sfts-date{max-width:100%;min-width:0}
}
@media(pointer:coarse){.sfts-btn,.sfts-chip,.sfts-select,.sfts-date{min-height:48px}.sfts-check{min-height:48px}}
`

    function makePage({ useT, openSession }) {
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
            h('div', { className: 'sfts-feedback', role: 'status', 'aria-live': 'polite', 'aria-atomic': true }, semanticText),
            h('div', { className: 'sfts-filters' },
              h('div', { className: 'sfts-group', role: 'group', 'aria-label': t('range') },
                h('span', null, t('range')),
                RANGES.map(([id, key]) => h('button', {
                  key: id, type: 'button', className: 'sfts-chip', 'aria-pressed': range === id, onClick: () => change(setRange, id),
                }, t(key))),
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
                ['relevance', 'recent'].map(id => h('button', {
                  key: id, type: 'button', className: 'sfts-chip', 'aria-pressed': sort === id, onClick: () => change(setSort, id),
                }, t(id)))),
              h('label', { className: 'sfts-check' },
                h('input', { type: 'checkbox', checked: subagents, onChange: e => change(setSubagents, e.target.checked) }), t('subagents'))),
            h('div', { className: 'sfts-meta' },
              h('span', null,
                value ? fmt(t('results'), { sessions: value.totalSessions, hits: value.totalHits }) + (value.truncated ? t('capped') : '') : '',
                value ? ' · ' : '',
                status ? (indexing
                  ? fmt(t('indexing'), { done: status.indexing.done, total: status.indexing.total })
                  : fmt(t('indexed'), { sessions: status.sessions, docs: status.documents })) : ''),
              h('span', { className: 'sfts-meta-actions' },
                h('button', { type: 'button', className: 'sfts-btn small', onClick: () => api('reindex', {}).then(loadStatus).catch(() => {}) }, t('reindex')),
                h('button', { type: 'button', className: 'sfts-btn small', onClick: () => api('reindex', { full: true }).then(loadStatus).catch(() => {}) }, t('rebuild')))),
            h('div', { className: 'sfts-feedback', role: 'status', 'aria-live': 'polite' }, state.status === 'loading' ? t('searching') : ''),
            state.status === 'error' ? h('div', { className: 'sfts-error', role: 'alert' }, fmt(t('error'), { msg: state.error })) : null,
            !value && state.status !== 'loading' && state.status !== 'error' ? h('div', { className: 'sfts-empty' }, t('hint')) : null,
            value && value.sessions.length === 0 ? h('div', { className: 'sfts-empty' }, t('none')) : null,
            value ? h('div', { className: 'sfts-list' },
              value.sessions.map(session => h('button', {
                key: session.sessionId, type: 'button', className: 'sfts-card', title: t('open'),
                onClick: () => openSession(session.sessionId),
              },
              h('div', { className: 'sfts-card-head' },
                h('span', { className: 'sfts-card-title' }, session.title || t('untitled')),
                h('span', { className: 'sfts-card-sub' },
                  `${baseName(session.cwd)} · ${fmt(t('hits'), { n: session.hits })} · ${fmtTime(session.lastMatchAt)}`)),
              session.matches.map(match => h('div', { key: match.seq, className: 'sfts-match' },
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
        function openSession(id) {
          const ui = ctx.get('uiWorkspace')
          if (ui && typeof ui.openSession === 'function') ui.openSession(id)
        }
        const Page = makePage({ useT, openSession })
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL, locale: NS }, Page))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist', id: PANEL, order: 30, label: () => t('title'), locale: NS,
        }, SearchIcon))
      },
    }
  },
})
