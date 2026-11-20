import { createHash } from 'node:crypto'

export const RETRIEVAL_VERSION = 1
export function evidenceId(ref) {
  return createHash('sha256').update(JSON.stringify([ref.userId, ref.deviceId, ref.profile, ref.sessionId, ref.seq])).digest('hex')
}
const denied = () => Object.assign(new Error('session retrieval: scope denied'), { code: 'SCOPE_DENIED' })
const failure = code => Object.assign(new Error('session retrieval: ' + code), { code })
function bound(value) {
  if (value === undefined) return undefined
  const time = typeof value === 'number' ? value : Date.parse(value)
  if (!Number.isFinite(time)) throw failure('INVALID_TIME')
  return time
}
async function bounded(run, ms, signal) {
  const controller = new AbortController()
  let timer, abort
  const cancelled = new Promise((_, reject) => {
    abort = () => { controller.abort(); reject(failure('ABORTED')) }
    if (signal?.aborted) abort()
    else signal?.addEventListener('abort', abort, { once: true })
    timer = setTimeout(() => { controller.abort(); reject(failure('TIMEOUT')) }, ms)
  })
  try { return await Promise.race([cancelled, Promise.resolve().then(() => {
    if (controller.signal.aborted) throw failure('ABORTED')
    return run(controller.signal)
  })]) } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort) }
}

/** One backend per result, host-bound identity, exact device/workspace authorization. */
export class SessionRetrieval {
  constructor(identity, localSearch, options = {}) {
    this.identity = Object.freeze({ ...identity })
    this.localSearch = localSearch
    this.timeoutMs = options.timeoutMs ?? 1800
    this.remote = null
    this.active = 0
    this.maxConcurrent = options.maxConcurrent ?? 2
    this.version = RETRIEVAL_VERSION
  }
  registerRemote(adapter) {
    for (const key of ['userId', 'deviceId', 'profile']) if (adapter.identity[key] !== this.identity[key]) throw denied()
    if (this.remote) throw new Error('session retrieval: remote adapter already registered')
    this.remote = adapter
    return () => { if (this.remote === adapter) this.remote = null }
  }
  async search(input, principal, signal) {
    for (const key of ['userId', 'deviceId', 'profile']) if (principal?.[key] !== this.identity[key]) throw denied()
    const scope = input.scope ?? 'workspace'
    if (!['workspace', 'all'].includes(scope)) throw denied()
    if (scope === 'workspace' && (typeof input.cwd !== 'string' || !input.cwd)) throw denied()
    if (typeof input.query !== 'string' || !input.query.trim() || input.query.length > 500) throw failure('INVALID_QUERY')
    const from = bound(input.from), to = bound(input.to)
    if (from > to) throw failure('INVALID_TIME_RANGE')
    const request = { ...input, scope, from, to, cwd: scope === 'workspace' ? input.cwd : undefined,
      limit: Math.min(20, Math.max(1, Number.isSafeInteger(input.limit) ? input.limit : 3)), offset: 0 }
    if (this.active >= this.maxConcurrent) throw failure('BUSY')
    const remote = this.remote
    // Workspace mapping is administrator config held by the adapter, never query input.
    const scopes = [{ deviceId: this.identity.deviceId, cwd: request.cwd }, ...(remote?.workspaceScopes?.(request.cwd) ?? [])]
    this.active++
    const deadline = Date.now() + this.timeoutMs
    try {
      let result, backend = 'local', fallback = null
      if (input.backend === 'central' && remote) {
        try {
          result = await bounded(s => remote.search(request, s), Math.min(800, this.timeoutMs / 2), signal)
          if (!result || !Array.isArray(result.hits)) throw failure('INVALID_RESPONSE')
          backend = 'central'
        } catch (error) {
          if (error.status === 401 || error.status === 403 || ['SCOPE_DENIED','ABORTED'].includes(error.code)) throw error
          result = undefined
          fallback = error.code ?? 'central_unavailable'
        }
      }
      if (!result) {
        const remaining = Math.max(1, deadline - Date.now())
        result = (await bounded(s => this.localSearch(request, s, remaining), remaining, signal)).result
      }
      const hits = []
      const seen = new Set()
      for (const session of result.sessions ?? []) for (const match of session.matches ?? []) {
        const ref = { ...this.identity, sessionId: session.sessionId, seq: match.seq,
          time: match.time, workspace: session.cwd, source: 'dsh-native-event' }
        if (!Number.isSafeInteger(ref.seq) || ref.seq < 0 || !Number.isFinite(match.time)) continue
        hits.push({ id: evidenceId(ref), ...ref, cwd: session.cwd, role: match.role,
          content: String(match.snippet).slice(0, 1200), createdAt: new Date(match.time).toISOString() })
      }
      if (backend === 'central') hits.push(...result.hits)
      const safe = hits.filter(hit => {
        if (hit.userId !== this.identity.userId || hit.profile !== this.identity.profile) return false
        if (hit.deviceId === this.identity.deviceId && hit.sessionId === input.excludeSessionId) return false
        if (scope === 'workspace' && !scopes.some(s => hit.deviceId === s.deviceId && hit.cwd === s.cwd)) return false
        const time = hit.time ?? Date.parse(hit.createdAt)
        if ((from !== undefined || to !== undefined) && (!Number.isFinite(time) || time < from || time > to)) return false
        if (Number.isSafeInteger(hit.seq) && (hit.seq < 0 || hit.id !== evidenceId(hit))) return false
        if (!hit.id || seen.has(hit.id)) return false
        seen.add(hit.id)
        return true
      }).slice(0, request.limit).map(hit => ({ ...hit, content: String(hit.content).slice(0, 1200) }))
      return { version: this.version, backend, fallback, hits: safe }
    } finally { this.active-- }
  }
}
