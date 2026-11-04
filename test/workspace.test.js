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
    rmSync(dir, { recursive: true, force: true })
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
    rmSync(dir, { recursive: true, force: true })
  }
})
