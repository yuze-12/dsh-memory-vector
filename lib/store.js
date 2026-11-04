import { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const LAYER_WEIGHT = { 1: 0.9, 2: 0.95, 3: 1.0, 4: 1.08, 5: 1.16 }

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
  const copy = Uint8Array.from(buffer)
  return new Float32Array(copy.buffer)
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

const DEFAULT_LAYER = { turn: 1, fact: 2, preference: 3, diary: 4, note: 5, core: 5 }

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
    `)
    this.#migrate()
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS memories_kind ON memories(kind);
      CREATE INDEX IF NOT EXISTS memories_pinned ON memories(pinned);
      CREATE INDEX IF NOT EXISTS memories_layer ON memories(layer);
    `)
  }

  #migrate() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(memories)').all().map(row => row.name))
    const additions = [
      ['layer', 'INTEGER NOT NULL DEFAULT 1'],
      ['access_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['last_access_at', 'INTEGER'],
      ['updated_at', 'INTEGER'],
      ['topic', 'TEXT'],
      ['date', 'TEXT'],
      ['source_ids', 'TEXT'],
      ['meta', 'TEXT'],
    ]
    for (const [name, type] of additions) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`)
    }
    this.db.prepare('UPDATE memories SET updated_at = created_at WHERE updated_at IS NULL').run()
  }

  add({ text, kind = 'fact', sessionId = null, seq = null, role = null, importance = 0.5,
    pinned = false, embedding = null, layer = null, topic = null, date = null,
    sourceIds = null, meta = null }) {
    const content = String(text || '').trim()
    if (!content) return null
    const digest = hash(content)
    const existing = this.db.prepare('SELECT id FROM memories WHERE hash = ?').get(digest)
    if (existing) return Number(existing.id)
    const effectiveLayer = pinned ? 5 : (layer ?? DEFAULT_LAYER[kind] ?? 1)
    const now = Date.now()
    const info = this.db.prepare(`
      INSERT INTO memories (hash, kind, text, session_id, seq, role, importance, pinned, embedding, dim,
        created_at, layer, access_count, updated_at, topic, date, source_ids, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `).run(digest, kind, content, sessionId, seq, role, Number(importance) || 0.5,
      pinned ? 1 : 0, embedding ? toBuffer(embedding) : null,
      embedding ? embedding.length : null, now, effectiveLayer, now,
      topic, date, sourceIds ? JSON.stringify(sourceIds) : null,
      meta ? JSON.stringify(meta) : null)
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
    return this.db.prepare('SELECT * FROM memories WHERE pinned = 1 ORDER BY layer DESC, importance DESC, id DESC LIMIT ?')
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
      rows = this.db.prepare('SELECT * FROM memories WHERE text LIKE ? ORDER BY layer DESC, importance DESC, id DESC LIMIT ?')
        .all(like, Number(limit))
    }
    return this.#rank(rows).slice(0, Number(limit))
  }

  vector(queryVector, limit = 8, scan = 4000) {
    if (!queryVector || !queryVector.length) return []
    const rows = this.db.prepare('SELECT * FROM memories WHERE embedding IS NOT NULL ORDER BY id DESC LIMIT ?')
      .all(Number(scan))
    const scored = []
    for (const row of rows) {
      const vector = toVector(row.embedding)
      if (!vector) continue
      const similarity = cosine(queryVector, vector)
      if (similarity <= 0.2) continue
      const boost = LAYER_WEIGHT[Number(row.layer)] || 1
      scored.push({ row, score: similarity * boost + Number(row.importance) * 0.01 })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, Number(limit)).map(item => ({ ...this.#view(item.row), score: item.score }))
  }

  touch(ids) {
    const list = [...new Set((ids || []).map(Number).filter(Boolean))]
    if (list.length === 0) return 0
    const now = Date.now()
    const statement = this.db.prepare('UPDATE memories SET access_count = access_count + 1, last_access_at = ? WHERE id = ?')
    for (const id of list) statement.run(now, id)
    return list.length
  }

  /** Promote memories with enough importance or access. Never rewrites text. */
  maintain() {
    const promoted = []
    const rows = this.db.prepare('SELECT id, layer, importance, access_count, pinned FROM memories WHERE pinned = 0').all()
    for (const row of rows) {
      const layer = Number(row.layer)
      const importance = Number(row.importance)
      const access = Number(row.access_count)
      let target = layer
      if (layer === 1 && (importance >= 6 || access >= 2)) target = 2
      else if (layer === 2 && (importance >= 7 || access >= 4)) target = 3
      else if (layer === 3 && (importance >= 8.5 || access >= 7)) target = 4
      else if (layer === 4 && (importance >= 9.5 || access >= 12)) target = 5
      if (target > layer) {
        this.db.prepare('UPDATE memories SET layer = ?, updated_at = ? WHERE id = ?').run(target, Date.now(), row.id)
        promoted.push({ id: Number(row.id), layer: target })
      }
    }
    return promoted
  }

  /** Gently fade low-value short-term memories that were never recalled. */
  decay(days = 30) {
    const cutoff = Date.now() - Number(days) * 86400000
    const rows = this.db.prepare(`
      SELECT id, importance FROM memories
      WHERE pinned = 0 AND layer <= 2 AND access_count = 0 AND created_at < ?
    `).all(cutoff)
    const statement = this.db.prepare('UPDATE memories SET importance = ? WHERE id = ?')
    for (const row of rows) statement.run(Math.max(0.1, Number(row.importance) * 0.95), row.id)
    return rows.length
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
    const byLayer = this.db.prepare('SELECT layer, COUNT(*) AS n FROM memories GROUP BY layer ORDER BY layer').all()
      .map(row => ({ layer: Number(row.layer), count: Number(row.n) }))
    return { total, pinned, embedded, byKind, byLayer, path: this.path }
  }

  #rank(rows) {
    return rows
      .map(row => ({ ...this.#view(row),
        score: (LAYER_WEIGHT[Number(row.layer)] || 1) + Number(row.importance) * 0.01 }))
      .sort((a, b) => b.score - a.score)
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
      layer: Number(row.layer || 1),
      accessCount: Number(row.access_count || 0),
      topic: row.topic || null,
      date: row.date || null,
      sourceIds: row.source_ids ? JSON.parse(row.source_ids) : [],
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
