import { createServer, connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPeerServer } from '../src/index.js'
import { buildReply, parsePeerMessage } from '../src/protocol.js'

/**
 * 集成测试:模拟一个 Claude peer(绑 socket),向插件 server 投递 NDJSON,
 * 验证插件能收到、解析,并能回发到对方的 socket。
 */
describe('peer server integration', () => {
  let serverDir: string
  let pluginServer: ReturnType<typeof createPeerServer>
  let received: ReturnType<typeof parsePeerMessage>[] = []
  let pluginSock: string
  let peerSock: string

  beforeAll(async () => {
    serverDir = await import('node:fs/promises').then(({ mkdtemp }) => mkdtemp(join(tmpdir(), 'socket-bridge-')))
    pluginSock = join(serverDir, 'dsh-peer.sock')
    peerSock = join(serverDir, 'claude-peer.sock')

    // 插件侧 server
    pluginServer = createPeerServer((msg) => { received.push(msg) })
    await new Promise<void>((resolve) => pluginServer.listen(pluginSock, resolve))
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => pluginServer.close(() => resolve()))
  })

  it('插件 server 收到 NDJSON 并解析', async () => {
    const line = JSON.stringify({
      msgV: 1,
      msg_id: 'test-123',
      type: 'user',
      message: {
        role: 'user',
        content: '<cross-session-message from="uds:/tmp/claude.sock" from-name="claude-peer">你好 dsh!</cross-session-message>',
      },
      priority: 'next',
      from: 'uds:/tmp/claude.sock',
    })
    await new Promise<void>((resolve, reject) => {
      const conn = connect(pluginSock, () => {
        conn.write(line + '\n', () => { conn.end(); resolve() })
      })
      conn.on('error', reject)
    })
    // 等 server 处理
    await new Promise((r) => setTimeout(r, 50))
    expect(received.length).toBe(1)
    expect(received[0]!.text).toBe('你好 dsh!')
    expect(received[0]!.fromName).toBe('claude-peer')
  })

  it('插件 server 能回发到模拟 peer 的 socket', async () => {
    // 模拟 peer:监听一个 socket,插件向它 connect 发送回复。
    let got = ''
    await new Promise<void>((resolve) => {
      const peer = createServer((conn) => {
        conn.on('data', (chunk) => { got += chunk.toString('utf8') })
        conn.on('end', resolve)
      })
      peer.listen(peerSock, () => {
        // 插件侧发一条回复
        const reply = buildReply(
          { msgId: 'test-123', from: 'uds:' + peerSock, text: '收到', fromName: undefined },
          'dsh 收到!',
        )
        const out = connect(peerSock, () => {
          out.write(reply, () => { out.end() })
        })
        out.on('error', () => {})
      })
    })
    expect(got).toContain('dsh 收到!')
    expect(got).toContain('"from":"uds:' + peerSock + '"')
  })
})
