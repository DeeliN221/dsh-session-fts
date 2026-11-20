/** Revision-scoped LRU with an explicit entry and serialized-byte budget. */
export class ResultCache {
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries
    this.maxBytes = maxBytes
    this.bytes = 0
    this.entries = new Map()
    this.revision = -1
  }

  get(key, revision) {
    if (revision !== this.revision) this.clear(revision)
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key)
    this.entries.set(key, entry)
    return structuredClone(entry.value)
  }

  set(key, revision, value) {
    if (revision !== this.revision) this.clear(revision)
    const bytes = Buffer.byteLength(key) + Buffer.byteLength(JSON.stringify(value))
    if (bytes > this.maxBytes || this.maxEntries === 0) return
    const old = this.entries.get(key)
    if (old) { this.bytes -= old.bytes; this.entries.delete(key) }
    this.entries.set(key, { bytes, value: structuredClone(value) })
    this.bytes += bytes
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value
      this.bytes -= this.entries.get(oldest).bytes
      this.entries.delete(oldest)
    }
  }

  clear(revision = -1) {
    this.entries.clear()
    this.bytes = 0
    this.revision = revision
  }
}
