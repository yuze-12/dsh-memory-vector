import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryStore } from '../lib/store.js'

test('store: add, keyword search, pin, forget', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const store = new MemoryStore(join(dir, 'memory.db'))
  try {
    const id = store.add({ text: '我喜欢喝乌龙茶，不加糖。', kind: 'preference', pinned: true })
    assert.ok(id > 0)
    assert.equal(store.add({ text: '我喜欢喝乌龙茶，不加糖。' }), id)

    const hits = store.keyword('乌龙茶', 5)
    assert.ok(hits.some(row => row.text.includes('乌龙茶')))

    const stats = store.stats()
    assert.equal(stats.total, 1)
    assert.equal(stats.pinned, 1)
    assert.equal(store.pinned().length, 1)

    assert.equal(store.forget(id), true)
    assert.equal(store.stats().total, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('store: embeddings are stored and searched', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const store = new MemoryStore(join(dir, 'memory.db'))
  try {
    const a = store.add({ text: 'alpha' })
    const b = store.add({ text: 'beta' })
    store.setEmbedding(a, [1, 0, 0])
    store.setEmbedding(b, [0, 1, 0])
    const hits = store.vector([0.9, 0.1, 0], 1)
    assert.equal(hits.length, 1)
    assert.equal(hits[0].id, a)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
