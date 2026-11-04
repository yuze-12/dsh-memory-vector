import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

function hash(text) {
  return createHash('sha256').update(String(text)).digest('hex')
}

function ftsQuery(query) {
  const tokens = String(query || '')
    .split(/[^\p{L}\p{N}_]+/u)
    .map(token => token.trim())
    .filter(token => token.length > 0)
    .slice(0, 12)
  if (tokens.length === 0) return ''
  return tokens.map(token => '"' + token.replaceAll('"', '""') + '"').join(' OR ')
}

function toBuffer(vector) {
  return Buffer.from(new Float32Array(vector).buffer)
}

function toVector(blob) {
  if (!blob) return null
  const buffer = Buffer.isBuffer(blob) ? blob : Buffer.from(blob)
  if (buffer.byteLength % 4 !== 0) return null
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4)
}

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / Math.sqrt(na * nb)
}

export class MemoryStore {
  constructor(path) {
    if (!path) throw new Error('MemoryStore requires a database path')
    mkdirSync(dirname(path), { recursive: true })
    this.path = path
    this.db = new DatabaseSync(path)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hash TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL DEFAULT 'fact',
        text TEXT NOT NULL,
        session_id TEXT,
        seq INTEGER,
        role TEXT,
        importance REAL NOT NULL DEFAULT 0.5,
        pinned INTEGER NOT NULL DEFAULT 0,
        embedding BLOB,
        dim INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(text);
      CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS memories_pinned ON memories(pinned);
    `)
  }

  add({ text, kind = 'fact', sessionId = null, seq = null, role = null, importance = 0.5, pinned = false, embedding = null }) {
    const content = String(text || '').trim()
    if (!content) return null
    const digest = hash(content)
    const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(digest)
    if (existing) return Number(existing.id)
    const info = this.db.prepare(`
      INSERT INTO memories (hash, kind, text, session_id, seq, role, importance, pinned, embedding, dim, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(digest, kind, content, sessionId, seq, role, Number(importance) || 0.5,
      pinned ? 1 : 0, embedding ? toBuffer(embedding) : null,
      embedding ? embedding.length : null, Date.now())
    const id = Number(info.lastInsertRowid)
    this.db.prepare('INSERT INTO memories_fts (rowid, text) VALUES (?, ?)').run(id, content)
    return id
  }

  setEmbedding(id, vector) {
    if (!vector || !vector.length) return false
    this.db.prepare('UPDATE memories SET embedding = ?, dim = ? WHERE id = ?')
      .run(toBuffer(vector), vector.length, Number(id))
    return true
  }

  get(id) {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(Number(id)) || null
  }

  pinned(limit = 12) {
    return this.db.prepare('SELECT * FROM memories WHERE pinned = 1 ORDER BY importance DESC, id DESC LIMIT ?')
      .all(Number(limit))
      .map(row => this.#view(row))
  }

  keyword(query, limit = 8) {
    const match = ftsQuery(query)
    let rows = []
    if (match) {
      try {
        rows = this.db.prepare(`
          SELECT m.* FROM memories_fts f JOIN memories m ON m.id = f.rowid
          WHERE memories_fts MATCH ? ORDER BY rank LIMIT ?
        `).all(match, Number(limit))
      } catch {
        rows = []
      }
    }
    if (rows.length === 0) {
      const like = '%' + String(query || '').trim() + '%'
      rows = this.db.prepare('SELECT * FROM memories WHERE text LIKE ? ORDER BY importance DESC, id DESC LIMIT ?')
        .all(like, Number(limit))
    }
    return rows.map(row => this.#view(row))
  }

  vector(queryVector, limit = 8, scan = 4000) {
    if (!queryVector || !queryVector.length) return []
    const rows = this.db.prepare('SELECT * FROM memories WHERE embedding IS NOT NULL ORDER BY id DESC LIMIT ?')
      .all(Number(scan))
    const scored = []
    for (const row of rows) {
      const vector = toVector(row.embedding)
      if (!vector) continue
      const score = cosine(queryVector, vector)
      if (score > 0.2) scored.push({ row, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Number(limit)).map(item => ({ ...this.#view(item.row), score: item.score }))
  }

  forget(id) {
    const numeric = Number(id)
    this.db.prepare('DELETE FROM memories_fts WHERE rowid = ?').run(numeric)
    return this.db.prepare('DELETE FROM memories WHERE id = ?').run(numeric).changes > 0
  }

  stats() {
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories').get().n)
    const pinned = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE pinned = 1').get().n)
    const embedded = Number(this.db.prepare('SELECT COUNT(*) AS n FROM memories WHERE embedding IS NOT NULL').get().n)
    const byKind = this.db.prepare('SELECT kind, COUNT(*) AS n FROM memories GROUP BY kind').all()
      .map(row => ({ kind: row.kind, count: Number(row.n) }))
    return { total, pinned, embedded, byKind, path: this.path }
  }

  #view(row) {
    return {
      id: Number(row.id),
      kind: row.kind,
      text: row.text,
      sessionId: row.session_id,
      seq: row.seq === null ? null : Number(row.seq),
      role: row.role,
      importance: Number(row.importance),
      pinned: Boolean(row.pinned),
      createdAt: Number(row.created_at),
    }
  }

  close() {
    this.db.close()
  }
}

export function newMemoryId() {
  return randomUUID()
}
