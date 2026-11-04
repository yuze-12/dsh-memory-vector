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

test('store: layers, diary and notes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-'))
  const store = new MemoryStore(join(dir, 'memory.db'))
  try {
    const turn = store.add({ text: '普通一句', kind: 'turn' })
    const diary = store.add({ text: '今天聊了很多', kind: 'diary', date: '2026-11-04' })
    const note = store.add({ text: '睡前要道晚安', kind: 'note', topic: '睡前', pinned: true })
    assert.equal(store.get(turn).layer, 1)
    assert.equal(store.get(diary).layer, 4)
    assert.equal(store.get(note).layer, 5)
    assert.equal(store.pinned().length, 1)

    store.db.prepare('UPDATE memories SET importance = 7 WHERE id = ?').run(turn)
    const promoted = store.maintain()
    assert.ok(promoted.some(row => row.id === turn && row.layer === 2))
    assert.equal(store.get(turn).layer, 2)

    store.touch([turn, turn])
    assert.equal(store.get(turn).access_count, 1)
    assert.equal(store.stats().byLayer.find(row => row.layer === 4).count, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
