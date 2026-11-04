import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'

function mockContext() {
  const handlers = new Map()
  const tools = []
  return {
    handlers,
    toolDefs: tools,
    disposers: [],
    on(name, handler) { handlers.set(name, handler) },
    tools: { register(def) { tools.push(def) } },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') this.disposers.push(dispose) },
    logger: { info() {}, warn() {}, error() {} },
  }
}

test('plugin: captures a turn, recalls it, and registers the memory tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-memory-plugin-'))
  const ctx = mockContext()
  try {
    apply(ctx, { dbPath: join(dir, 'memory.db'), embedding: { provider: 'none' } })
    assert.equal(ctx.toolDefs.length, 10)
    assert.ok(ctx.handlers.has('session/event'))
    assert.ok(ctx.handlers.has('agent/pre-step'))

    ctx.handlers.get('session/event')(
      { id: 'session-1' },
      { type: 'user/message', seq: 1, data: { message: { id: 'm1', role: 'user', content: [{ type: 'text', text: '我平时喝乌龙茶，不加糖。' }] } } },
    )

    const decision = await ctx.handlers.get('agent/pre-step')(
      { step: 1 },
      async () => ({ kind: 'enter', messages: [{ role: 'user', content: [{ type: 'text', text: '乌龙茶？' }] }] }),
    )
    assert.equal(decision.kind, 'enter')
    const injected = decision.messages[0]
    assert.match(JSON.stringify(injected.content), /乌龙茶/)
  } finally {
    for (const dispose of ctx.disposers) dispose()
    rmSync(dir, { recursive: true, force: true })
  }
})
