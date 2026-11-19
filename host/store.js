/**
 * Local SQLite store: derived, disposable full-text index of Session logs.
 *
 * Tables: `sessions` (one row per indexed Session with its index stamp),
 * `events` (one searchable document per event), and `fts`, a contentless
 * FTS5 table whose rowid equals `events.id`. The store never touches the
 * Session persistence files.
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { tokenizeForIndex, makeSnippet } from './text.js'

const SCHEMA_VERSION = '1'
const RAW_ROW_CAP = 5000
const SNIPPETS_PER_SESSION = 3

export class FtsStore {
  /**
   * @param {string} path - absolute index path.
   * @param {string} optionsKey - extraction options; a change rebuilds the index.
   */
  constructor(path, optionsKey) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.path = path
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=3000;')
    this._migrate(optionsKey)
    this._prepare()
  }

  _migrate(optionsKey) {
    const db = this.db
    db.exec('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)')
    const read = key => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value
    if (read('schema') !== SCHEMA_VERSION || read('options') !== optionsKey) {
      db.exec('DROP TABLE IF EXISTS fts; DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS sessions;')
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY, cwd TEXT, parent TEXT, origin TEXT, title TEXT,
        created_at INTEGER, updated_at INTEGER, stamp TEXT,
        indexed_seq INTEGER NOT NULL DEFAULT -1, doc_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS events(
        id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, seq INTEGER NOT NULL,
        role TEXT NOT NULL, time INTEGER NOT NULL, text TEXT NOT NULL,
        UNIQUE(session_id, seq));
      CREATE INDEX IF NOT EXISTS events_time ON events(time);
      CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(
        tok, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2');
    `)
    const write = db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    write.run('schema', SCHEMA_VERSION)
    write.run('options', optionsKey)
  }

  _prepare() {
    const db = this.db
    this._sessionRow = db.prepare('SELECT * FROM sessions WHERE id = ?')
    this._sessionIds = db.prepare('SELECT id FROM sessions')
    this._upsert = db.prepare(`
      INSERT INTO sessions(id, cwd, parent, origin, title, created_at, updated_at, stamp, indexed_seq, doc_count)
      VALUES (:id, :cwd, :parent, :origin, :title, :created_at, :updated_at, :stamp, :indexed_seq, :doc_count)
      ON CONFLICT(id) DO UPDATE SET cwd = excluded.cwd, parent = excluded.parent, origin = excluded.origin,
        title = excluded.title, created_at = excluded.created_at, updated_at = excluded.updated_at,
        stamp = excluded.stamp, indexed_seq = excluded.indexed_seq, doc_count = excluded.doc_count`)
    this._insertEvent = db.prepare(`
      INSERT INTO events(session_id, seq, role, time, text) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(session_id, seq) DO NOTHING RETURNING id`)
    this._insertFts = db.prepare('INSERT INTO fts(rowid, tok) VALUES (?, ?)')
    this._deleteFts = db.prepare('DELETE FROM fts WHERE rowid IN (SELECT id FROM events WHERE session_id = ?)')
    this._deleteEvents = db.prepare('DELETE FROM events WHERE session_id = ?')
    this._deleteSession = db.prepare('DELETE FROM sessions WHERE id = ?')
  }

  /** @returns {any} the stored row of one Session, or undefined. */
  sessionRow(id) {
    return this._sessionRow.get(id)
  }

  /** @returns {string[]} every indexed Session id. */
  sessionIds() {
    return this._sessionIds.all().map(row => row.id)
  }

  /**
   * Append documents and update the Session row in one transaction.
   * @param {object} row - complete Session row values except doc_count.
   * @param {Array<{seq:number, role:string, time:number, text:string}>} docs - new documents.
   */
  commit(row, docs) {
    const previous = this.sessionRow(row.id)
    let added = 0
    this.db.exec('BEGIN')
    try {
      for (const doc of docs) {
        const inserted = this._insertEvent.get(row.id, doc.seq, doc.role, doc.time, doc.text)
        if (inserted === undefined) continue
        this._insertFts.run(inserted.id, tokenizeForIndex(doc.text))
        added++
      }
      this._upsert.run({ ...row, doc_count: (previous?.doc_count ?? 0) + added })
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
    return added
  }

  /** Remove one Session and its documents. */
  deleteSession(id) {
    this.db.exec('BEGIN')
    try {
      this._deleteFts.run(id)
      this._deleteEvents.run(id)
      this._deleteSession.run(id)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** Drop every document; the next reconcile rebuilds from the logs. */
  clear() {
    this.db.exec('BEGIN')
    try {
      this.db.exec("DELETE FROM events; DELETE FROM sessions; INSERT INTO fts(fts) VALUES('delete-all');")
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** @returns {{sessions:number, documents:number, oldest:number|null, newest:number|null}} totals. */
  stats() {
    const row = this.db.prepare(
      'SELECT (SELECT count(*) FROM sessions) AS sessions, count(*) AS documents, min(time) AS oldest, max(time) AS newest FROM events',
    ).get()
    return { sessions: row.sessions, documents: row.documents, oldest: row.oldest ?? null, newest: row.newest ?? null }
  }

  /** @returns {Array<{cwd:string, sessions:number, updatedAt:number}>} indexed working directories. */
  workspaces() {
    return this.db.prepare(
      'SELECT cwd, count(*) AS sessions, max(updated_at) AS updatedAt FROM sessions WHERE cwd IS NOT NULL GROUP BY cwd ORDER BY updatedAt DESC',
    ).all().map(row => ({ cwd: row.cwd, sessions: row.sessions, updatedAt: row.updatedAt }))
  }

  /**
   * Run one compiled query and group hits by Session.
   * @param {object} q - compiled query and filters.
   * @returns {object} grouped page.
   */
  search(q) {
    const where = ['fts MATCH ?']
    const params = [q.match]
    if (q.from !== undefined) { where.push('e.time >= ?'); params.push(q.from) }
    if (q.to !== undefined) { where.push('e.time <= ?'); params.push(q.to) }
    if (q.roles !== undefined && q.roles.length > 0) {
      where.push(`e.role IN (${q.roles.map(() => '?').join(', ')})`)
      params.push(...q.roles)
    }
    if (q.cwd !== undefined) { where.push('s.cwd = ?'); params.push(q.cwd) }
    if (!q.includeSubagents) where.push("(s.origin IS NULL OR s.origin != 'subagent')")
    if (q.excludeSessionId !== undefined) { where.push('e.session_id != ?'); params.push(q.excludeSessionId) }
    const sql = `SELECT e.session_id AS sid, e.seq, e.role, e.time, e.text, bm25(fts) AS score
      FROM fts JOIN events e ON e.id = fts.rowid JOIN sessions s ON s.id = e.session_id
      WHERE ${where.join(' AND ')} ORDER BY score LIMIT ${RAW_ROW_CAP + 1}`
    const rows = this.db.prepare(sql).all(...params)
    const truncated = rows.length > RAW_ROW_CAP
    if (truncated) rows.length = RAW_ROW_CAP
    const groups = new Map()
    for (const row of rows) {
      let group = groups.get(row.sid)
      if (group === undefined) {
        group = { sessionId: row.sid, hits: 0, best: row.score, lastTime: row.time, matches: [] }
        groups.set(row.sid, group)
      }
      group.hits++
      if (row.time > group.lastTime) group.lastTime = row.time
      if (group.matches.length < SNIPPETS_PER_SESSION) {
        group.matches.push({ seq: row.seq, role: row.role, time: row.time, snippet: makeSnippet(row.text, q.terms) })
      }
    }
    const ordered = [...groups.values()]
    ordered.sort(q.sort === 'recent' ? (a, b) => b.lastTime - a.lastTime : (a, b) => a.best - b.best)
    const page = ordered.slice(q.offset, q.offset + q.limit).map((group) => {
      const meta = this.sessionRow(group.sessionId)
      return {
        sessionId: group.sessionId,
        title: meta?.title ?? null,
        cwd: meta?.cwd ?? null,
        createdAt: meta?.created_at ?? null,
        updatedAt: meta?.updated_at ?? null,
        subagent: meta?.origin === 'subagent',
        hits: group.hits,
        lastMatchAt: group.lastTime,
        matches: group.matches,
      }
    })
    return { totalHits: rows.length, totalSessions: ordered.length, truncated, sessions: page }
  }

  close() {
    try { this.db.close() } catch { /* already closed */ }
  }
}
