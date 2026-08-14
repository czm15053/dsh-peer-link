import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { apply } from '../src/index.js'

/**
 * apply 集成测试:用真实 cordis Context + 服务桩,加载插件,
 * 注入临时目录,模拟 Claude 投递,验证:
 *   - 注册文件写入临时 sessionDir
 *   - socket 监听
 *   - agent.inject 被调用(消息进入模型上下文)
 */
describe('apply integration', () => {
  let dir: string
  let sessionDir: string
  let sockDir: string
  let injected: string[] = []

  // 最小 ctx:提供 agents/tools/systemPrompt 三个服务,并模拟 agent/created 事件。
  function makeCtx() {
    const fakeAgent = {
      id: 'session-test-0001',
      inject(msg: { content: { text: string }[] }) {
        injected.push(msg.content.map((b) => b.text).join(''))
      },
      followup(msg: { content: { text: string }[] }) {
        injected.push(msg.content.map((b) => b.text).join(''))
      },
      session: { meta: { cwd: sessionDir }, seq: 5 },
    }
    const listeners: Record<string, ((payload: unknown) => void)[]> = {}
    const emit = (event: string, payload: unknown): void => {
      for (const fn of listeners[event] ?? []) fn(payload)
    }
    const ctx = {
      agents: { list: () => [fakeAgent] },
      tools: { register: () => () => {} },
      systemPrompt: { section: () => () => {} },
      on(event: string, fn: (payload: unknown) => void) {
        (listeners[event] ??= []).push(fn)
      },
      effect(fn: () => unknown, _name?: string) {
        const result = fn()
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          return (result as Promise<() => void>).catch((e) => console.error('effect error', e))
        }
        return result
      },
    } as never
    return { ctx: ctx as never, emit: emit as (e: string, p: unknown) => void, fakeAgent }
  }

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'socket-bridge-apply-'))
    sessionDir = join(dir, 'sessions')
    sockDir = join(dir, 'socks')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(sessionDir, { recursive: true })
    await mkdir(sockDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('插件加载:单 peer 注册 + socket 收消息注入', async () => {
    const { ctx, emit, fakeAgent } = makeCtx()
    apply(ctx, { sessionDir, sockDir, name: 'dsh-test' })
    // 触发 agent/created,让插件记录该 session 的短 id(用于转发)。
    emit('agent/created', { agent: fakeAgent })
    // 等异步注册 + listen 完成
    await new Promise((r) => setTimeout(r, 200))

    // 注册文件存在(单 peer,文件名 <pid>.json)
    const files = await readdir(sessionDir)
    expect(files.length).toBe(1)
    // socket 路径:sockDir/<pid>.sock
    const sockPath = join(sockDir, `${process.pid}.sock`)

    // 投递一条 Claude 消息到该 session 的 socket
    const line = JSON.stringify({
      msgV: 1,
      msg_id: 'apply-test-1',
      type: 'user',
      message: {
        role: 'user',
        content: '<cross-session-message from="uds:/tmp/x.sock" from-name="claude-x">hello dsh!</cross-session-message>',
      },
      priority: 'next',
      from: 'uds:/tmp/x.sock',
    })
    await new Promise<void>((resolve, reject) => {
      const conn = connect(sockPath, () => {
        conn.write(line + '\n', () => { conn.end(); resolve() })
      })
      conn.on('error', reject)
    })
    await new Promise((r) => setTimeout(r, 100))

    // agent.followup 被调用,消息用纯文本格式注入(气泡里不渲染 markdown)
    expect(injected.length).toBe(1)
    expect(injected[0]).toContain('hello dsh!')
    expect(injected[0]).toContain('claude-x 说')
    expect(injected[0]).toContain('peer_send')
  })
})
