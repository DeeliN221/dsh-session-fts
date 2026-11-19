/**
 * Text extraction, CJK-aware tokenization, query compilation, and snippets.
 *
 * unicode61 treats an unspaced run of CJK characters as one token, so a
 * Chinese word inside a sentence is not findable. Spacing every CJK
 * character before indexing makes each one a token; a query is then compiled
 * to an FTS5 phrase of consecutive characters, which matches exactly where
 * the literal substring occurs. Latin text keeps word tokens.
 */

const CJK = /([\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af\u{20000}-\u{2fa1f}])/gu
const WORDISH = /[\p{L}\p{N}]/u
const MAX_TERMS = 8
const MAX_TERM_CHARS = 200

/**
 * Space every CJK character so unicode61 indexes it as its own token.
 * @param {string} text - raw text.
 * @returns {string} text ready for the FTS column.
 */
export function tokenizeForIndex(text) {
  return text.replace(CJK, ' $1 ')
}

/**
 * Compile a user query into FTS5 syntax. Every whitespace-separated term
 * becomes one quoted phrase (so FTS operators in user text stay inert) and
 * terms are ANDed. A term ending in a Latin letter or digit also matches
 * longer words that start with it.
 * @param {string} raw - user query.
 * @returns {{ terms: string[], match: string | null }} display terms and the MATCH expression.
 */
export function compileQuery(raw) {
  const terms = String(raw ?? '').trim().split(/\s+/u)
    .filter(Boolean)
    .map(term => term.slice(0, MAX_TERM_CHARS))
    .slice(0, MAX_TERMS)
  const parts = []
  for (const term of terms) {
    const tokens = tokenizeForIndex(term).trim().replace(/\s+/gu, ' ')
    if (!WORDISH.test(tokens)) continue
    const phrase = `"${tokens.replace(/"/g, '""')}"`
    parts.push(/[A-Za-z0-9]$/.test(term) ? `${phrase}*` : phrase)
  }
  return { terms, match: parts.length === 0 ? null : parts.join(' AND ') }
}

function blocksText(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Extract the searchable document of one Session event.
 *
 * User messages count only when the person wrote them (`source.kind ===
 * 'user'`); injected context such as skill catalogs, runtime context, and
 * time stamps is excluded. Reasoning blocks are excluded. Tool calls and
 * results are included only when the deployment opts in.
 * @param {any} event - one Session log event.
 * @param {{ tools: boolean }} options - extraction switches.
 * @returns {{ role: 'user' | 'assistant' | 'tool', text: string } | null} the document, or null.
 */
export function extractDocument(event, options) {
  const data = event?.data
  switch (event?.type) {
    case 'user/message': {
      if (data?.source?.kind !== 'user') return null
      return nonEmpty('user', blocksText(data.content))
    }
    case 'assistant/message':
      return nonEmpty('assistant', blocksText(data?.message?.content))
    case 'tool/call':
      if (!options.tools) return null
      return nonEmpty('tool', [data?.name, data?.arguments].filter(v => typeof v === 'string').join('\n'))
    case 'tool/result':
      if (!options.tools) return null
      return nonEmpty('tool', blocksText(data?.message?.content))
    default:
      return null
  }
}

function nonEmpty(role, text) {
  const trimmed = text.trim()
  return trimmed === '' ? null : { role, text: trimmed }
}

/**
 * Build a short plain-text excerpt around the first literal occurrence of
 * any query term. Falls back to the document start when the match spans
 * punctuation the tokenizer ignored.
 * @param {string} text - stored document text.
 * @param {string[]} terms - query terms.
 * @param {number} before - characters kept before the match.
 * @param {number} after - characters kept after the match start.
 * @returns {string} the excerpt.
 */
export function makeSnippet(text, terms, before = 60, after = 180) {
  const lower = text.toLowerCase()
  let at = -1
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase())
    if (index >= 0 && (at < 0 || index < at)) at = index
  }
  const start = at < 0 ? 0 : Math.max(0, at - before)
  const end = Math.min(text.length, (at < 0 ? 0 : at) + after)
  const body = text.slice(start, end).replace(/\s+/gu, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}
