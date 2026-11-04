import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function mockContext() {
  const handlers = new Map()
  const tools = []
  const disposers = []
  return {
    handlers,
    toolDefs: tools,
    disposers,
    on(name, handler) { handlers.set(name, handler) },
    tools: { register(def) { tools.push(def) } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose) },
    logger: { info() {}, warn() {}, error() {} },
  }
}

test('plugin: per-workspace stores are isolated', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ws-'))
  const ctx = mockContext()
  try {
    apply(ctx, { dbDir: dir, workspaceMode: 'per-workspace', embedding: { provider: 'none' } })
    const event = { type: 'user/message', seq: 1, data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '项目 A 的事' }] } } }
    ctx.handlers.get('session/event')({ id: 's1', header: { cwd: 'E:/proj/a' } }, event)
    ctx.handlers.get('session/event')({ id: 's2', header: { cwd: 'E:/proj/b' } },
      { ...event, data: { message: { ...event.data.message, id: 'm2' } } })
    const files = readdirSync(dir).filter(name => name.endsWith('.db'))
    assert.equal(files.length, 2)
  } finally {
    for (const dispose of ctx.disposers) dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('plugin: enabledWorkspaces blocks other projects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-ws-'))
  const ctx = mockContext()
  try {
    apply(ctx, {
      dbDir: dir, workspaceMode: 'per-workspace',
      enabledWorkspaces: ['E:/proj/a'], embedding: { provider: 'none' },
    })
    const event = { type: 'user/message', seq: 1, data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '不该记' }] } } }
    ctx.handlers.get('session/event')({ id: 's2', header: { cwd: 'E:/proj/b' } }, event)
    assert.equal(readdirSync(dir).filter(name => name.endsWith('.db')).length, 0)
  } finally {
    for (const dispose of ctx.disposers) dispose()
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  }
})

test('plugin: auto diary uses the llm and writes one entry', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-diary-'))
  const dbPath = join(dir, 'memory.db')
  const ctx = mockContext()
  ctx.llm = {
    async *stream() {
      yield { type: 'text-delta', text: '今天我们试了记忆系统，感觉还行。' }
    },
  }
  try {
    apply(ctx, {
      dbPath, embedding: { provider: 'none' },
      diary: { enabled: true, provider: 'test', model: 'test', hour: 0, minTurns: 1, delayMs: 0 },
    })
    const handler = ctx.handlers.get('session/event')
    handler({ id: 's1', header: { cwd: 'E:/proj/a' } },
      { type: 'user/message', seq: 1, data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '试试记忆' }] } } })
    handler({ id: 's1', header: { cwd: 'E:/proj/a' } },
      { type: 'assistant/message', seq: 2, data: { message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '好' }] } } })
    await new Promise(resolve => setTimeout(resolve, 120))
    const { MemoryStore } = await import('../lib/store.js')
    const check = new MemoryStore(dbPath)
    assert.equal(check.hasDiary(new Date().toISOString().slice(0, 10)), true)
    check.close()
  } finally {
    for (const dispose of ctx.disposers) dispose()
    await new Promise(resolve => setTimeout(resolve, 80))
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } catch {}
  }
})
