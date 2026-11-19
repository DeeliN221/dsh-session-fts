/**
 * Local full-text session search for DeepSeek Harness.
 *
 * Host half: owns a derived SQLite FTS5 index under the DSH home, keeps it in
 * step with the Session corpus, serves the Web page's search route, and
 * registers the `session_fts_search` agent tool. Everything stays on this
 * machine; no remote database or network call is involved.
 */

import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { FtsStore } from './host/store.js'
import { Indexer } from './host/indexer.js'
import { compileQuery } from './host/text.js'

export const name = 'session-fts'

export const inject = ['sessions', 'sessionQuery', 'tools']

const DAY_MS = 86_400_000
const ROUTE = '/session-fts/api'
const ROLES = ['user', 'assistant', 'tool']

function resolveConfig(config = {}) {
  const home = process.env.DSH_HOME && isAbsolute(process.env.DSH_HOME) ? process.env.DSH_HOME : join(homedir(), '.dsh')
  const path = typeof config.path === 'string' && config.path !== '' ? config.path : join(home, 'session-fts.sqlite')
  if (!isAbsolute(path)) throw new TypeError('session-fts: path must be absolute')
  const int = (value, fallback, min, max) => {
    const n = Number(value)
    return Number.isInteger(n) && n >= min && n <= max ? n : fallback
  }
  return {
    path,
    tools: config.indexToolOutput === true,
    defaultDays: int(config.defaultDays, 30, 0, 36500),
    maxResults: int(config.maxResults, 20, 1, 200),
    maxDocChars: int(config.maxDocChars, 20000, 500, 1_000_000),
    includeSubagents: config.includeSubagents === true,
    liveDelayMs: int(config.liveDelayMs, 1500, 100, 60000),
    startupDelayMs: int(config.startupDelayMs, 3000, 0, 600000),
  }
}

/**
 * Parse a date bound. A bare `YYYY-MM-DD` uses Host local time: the start of
 * that day for `from`, its last millisecond for `to`.
 * @param {unknown} value - ISO date, ISO date-time, or epoch milliseconds.
 * @param {'from'|'to'} edge - which bound.
 * @returns {number | undefined} epoch milliseconds.
 */
function parseBound(value, edge) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const text = String(value).trim()
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (day) {
    const date = new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]))
    return edge === 'from' ? date.getTime() : date.getTime() + DAY_MS - 1
  }
  const parsed = Date.parse(text)
  if (Number.isNaN(parsed)) throw new SearchInputError(`invalid ${edge} date: ${text}`)
  return parsed
}

class SearchInputError extends Error {}

/**
 * Normalize one search request shared by the page and the agent tool.
 * @param {any} input - request fields.
 * @param {ReturnType<typeof resolveConfig>} config - resolved config.
 * @returns {object} store query.
 */
function normalizeRequest(input, config) {
  const { terms, match } = compileQuery(input?.query)
  if (match === null) throw new SearchInputError('query must contain at least one letter or digit')
  let from = parseBound(input.from, 'from')
  const to = parseBound(input.to, 'to')
  if (from === undefined && input.days !== undefined && input.days !== null) {
    const days = Number(input.days)
    if (!Number.isFinite(days) || days < 0) throw new SearchInputError('days must be a non-negative number')
    if (days > 0) from = Date.now() - days * DAY_MS
  }
  if (from !== undefined && to !== undefined && from > to) throw new SearchInputError('from must not be after to')
  const roles = Array.isArray(input.roles) ? input.roles.filter(role => ROLES.includes(role)) : undefined
  const limit = Math.min(Math.max(Number.isInteger(input.limit) ? input.limit : config.maxResults, 1), 200)
  const offset = Number.isInteger(input.offset) && input.offset > 0 ? input.offset : 0
  return {
    terms,
    match,
    from,
    to,
    roles,
    cwd: typeof input.cwd === 'string' && input.cwd !== '' ? input.cwd : undefined,
    includeSubagents: input.includeSubagents === true || (input.includeSubagents === undefined && config.includeSubagents),
    excludeSessionId: typeof input.excludeSessionId === 'string' ? input.excludeSessionId : undefined,
    sort: input.sort === 'recent' ? 'recent' : 'relevance',
    limit,
    offset,
  }
}

async function readJson(req, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > maxBytes) throw new SearchInputError('request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

function formatTime(ms) {
  const date = new Date(ms)
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function renderToolText(result, request, scopeLabel) {
  const range = request.from === undefined && request.to === undefined
    ? 'all time'
    : `${request.from === undefined ? '…' : formatTime(request.from)} to ${request.to === undefined ? 'now' : formatTime(request.to)}`
  const lines = [
    `${result.totalSessions} session(s), ${result.totalHits} matching message(s)${result.truncated ? ' (capped)' : ''}; `
      + `scope: ${scopeLabel}; range: ${range}.`,
  ]
  if (result.sessions.length === 0) {
    lines.push('No matches. Try fewer or shorter terms, a wider range (days: 0 for all time), or scope "all".')
    return lines.join('\n')
  }
  result.sessions.forEach((session, index) => {
    lines.push('')
    lines.push(`${index + 1 + request.offset}. ${session.title ?? 'untitled'} — session_id ${session.sessionId}`)
    lines.push(`   cwd: ${session.cwd ?? '-'} · ${session.hits} hit(s) · last match ${formatTime(session.lastMatchAt)}`)
    for (const match of session.matches) {
      lines.push(`   - [${match.role} seq ${match.seq} ${formatTime(match.time)}] ${match.snippet}`)
    }
  })
  const shown = request.offset + result.sessions.length
  if (shown < result.totalSessions) lines.push('', `More sessions match: call again with offset ${shown}.`)
  return lines.join('\n')
}

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Words or phrases to find. Chinese/Japanese/Korean text matches as a literal substring; '
        + 'Latin words also match longer words that start with them. Space-separated terms are ANDed.',
    },
    days: {
      type: 'number',
      description: 'Only messages from the last N days. Omit for the configured default (30); 0 means all time. Ignored when from is set.',
    },
    from: { type: 'string', description: 'Earliest message time, YYYY-MM-DD (local) or ISO date-time.' },
    to: { type: 'string', description: 'Latest message time, YYYY-MM-DD (inclusive, local) or ISO date-time.' },
    scope: {
      type: 'string',
      enum: ['workspace', 'all'],
      description: 'workspace (default): only sessions whose working directory equals the current session\'s; all: every session.',
    },
    roles: {
      type: 'array',
      items: { type: 'string', enum: ROLES },
      description: 'Restrict to message authors. Omit for all indexed roles. "tool" exists only when tool output indexing is enabled.',
    },
    sort: { type: 'string', enum: ['relevance', 'recent'], description: 'Order sessions by best match (default) or latest match.' },
    limit: { type: 'integer', description: 'Sessions per page, 1-50.' },
    offset: { type: 'integer', description: 'Sessions to skip, for paging.' },
  },
  required: ['query'],
  additionalProperties: false,
}

function validateToolArgs(args) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw new SearchInputError('arguments must be an object')
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(TOOL_PARAMETERS.properties, key)) throw new SearchInputError(`unknown argument: ${key}`)
  }
  if (typeof args.query !== 'string') throw new SearchInputError('query must be a string')
  if (args.scope !== undefined && args.scope !== 'workspace' && args.scope !== 'all') throw new SearchInputError('scope must be workspace or all')
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 50)) {
    throw new SearchInputError('limit must be an integer from 1 to 50')
  }
}

export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const optionsKey = JSON.stringify({ tools: config.tools, maxDocChars: config.maxDocChars, v: 1 })
  const store = new FtsStore(config.path, optionsKey)
  const indexer = new Indexer(ctx, store, config)
  ctx.effect(() => () => {
    indexer.dispose()
    store.close()
  }, 'session-fts: store')

  ctx.on('session/event', (session) => {
    if (session?.id !== undefined) indexer.touch(session.id)
  })

  ctx.effect(() => {
    const timer = setTimeout(() => {
      indexer.reconcileAll().catch(error => ctx.logger?.warn?.(`session-fts: initial index failed: ${String(error)}`))
    }, config.startupDelayMs)
    return () => clearTimeout(timer)
  }, 'session-fts: initial index')

  async function search(input) {
    const request = normalizeRequest(input, config)
    await indexer.settle()
    return { request, result: store.search(request) }
  }

  ctx.effect(() => ctx.tools.register({
    name: 'session_fts_search',
    description: 'Full-text search over earlier sessions on this machine (local index). Finds Chinese text reliably, '
      + 'filters by time range (default: last 30 days), and returns each matching session with dated snippets. '
      + 'Defaults to sessions in the current working directory and excludes the current session.',
    parameters: TOOL_PARAMETERS,
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      validateToolArgs(args)
      const header = exec.agent?.session?.header
      const scope = args.scope ?? 'workspace'
      if (scope === 'workspace' && header?.cwd === undefined) {
        throw new SearchInputError('the current session has no working directory; use scope "all"')
      }
      const { request, result } = await search({
        ...args,
        days: args.from === undefined && args.days === undefined ? config.defaultDays : args.days,
        cwd: scope === 'workspace' ? header.cwd : undefined,
        excludeSessionId: exec.agent?.session?.id,
        limit: args.limit ?? Math.min(config.maxResults, 10),
      })
      return renderToolText(result, request, scope === 'workspace' ? header.cwd : 'all sessions')
    },
  }), 'session-fts: tool')

  ctx.inject(['webServer', 'connection'], (routeCtx) => {
    const fence = req => routeCtx.connection.requestRejection(req)
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const rejection = fence(req)
        if (rejection !== undefined) {
          writeJson(res, rejection, { ok: false, error: 'forbidden' })
          return
        }
        const url = new URL(req.url ?? '/', 'http://localhost')
        const action = url.pathname.slice(url.pathname.indexOf(ROUTE) + ROUTE.length).replace(/^\/+/, '')
        try {
          if (action === 'search' && req.method === 'POST') {
            const { result } = await search(await readJson(req))
            writeJson(res, 200, { ok: true, value: result })
          } else if (action === 'status' && req.method === 'GET') {
            writeJson(res, 200, {
              ok: true,
              value: {
                ...store.stats(),
                indexing: indexer.state,
                path: config.path,
                indexToolOutput: config.tools,
                defaultDays: config.defaultDays,
                workspaces: store.workspaces(),
              },
            })
          } else if (action === 'reindex' && req.method === 'POST') {
            const body = await readJson(req)
            const job = body?.full === true ? indexer.rebuild() : indexer.reconcileAll()
            job.catch(error => ctx.logger?.warn?.(`session-fts: reindex failed: ${String(error)}`))
            writeJson(res, 202, { ok: true, value: { started: true } })
          } else {
            writeJson(res, 404, { ok: false, error: 'not found' })
          }
        } catch (error) {
          const status = error instanceof SearchInputError || error instanceof SyntaxError ? 400 : 500
          writeJson(res, status, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }), 'session-fts: route')
  })
}
