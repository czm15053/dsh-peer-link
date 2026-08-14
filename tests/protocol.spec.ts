import { describe, expect, it } from 'vitest'
import { buildReply, extractFromName, extractText, parsePeerMessage, udsPathOf } from '../src/protocol.js'

/** Claude 投递的一条真实 NDJSON(仿 bridge/ARCHITECTURE.md)。 */
const SAMPLE = JSON.stringify({
  msgV: 1,
  msg_id: 'af27935e-6c00-6e49-0228-3038191e06c3',
  type: 'user',
  message: {
    role: 'user',
    content: '<cross-session-message from="uds:/tmp/cc-socks/13079.sock" from-name="peer-65">你好 👋</cross-session-message>',
  },
  priority: 'next',
  from: 'uds:/tmp/cc-socks/13079.sock',
})

describe('protocol', () => {
  it('解析真实 NDJSON 入站消息', () => {
    const msg = parsePeerMessage(SAMPLE)
    expect(msg).not.toBeNull()
    expect(msg!.msgId).toBe('af27935e-6c00-6e49-0228-3038191e06c3')
    expect(msg!.from).toBe('uds:/tmp/cc-socks/13079.sock')
    expect(msg!.text).toBe('你好 👋')
    expect(msg!.fromName).toBe('peer-65')
  })

  it('解析不带包装的 content', () => {
    const msg = parsePeerMessage(JSON.stringify({
      type: 'user',
      message: { role: 'user', content: '直接文本' },
      from: 'uds:/tmp/cc-socks/1.sock',
    }))
    expect(msg!.text).toBe('直接文本')
    expect(msg!.fromName).toBeUndefined()
  })

  it('忽略非 user 消息', () => {
    expect(parsePeerMessage(JSON.stringify({ type: 'control', message: { role: 'user', content: 'x' } }))).toBeNull()
    expect(parsePeerMessage('not-json')).toBeNull()
    expect(parsePeerMessage('')).toBeNull()
  })

  it('extractText 剥掉包装', () => {
    expect(extractText('<cross-session-message from="x" from-name="y">内部</cross-session-message>')).toBe('内部')
    expect(extractText('普通文本')).toBe('普通文本')
  })

  it('extractFromName 取注册名', () => {
    expect(extractFromName('<cross-session-message from="x" from-name="peer-x">你好</cross-session-message>')).toBe('peer-x')
    expect(extractFromName('<cross-session-message from="x">你好</cross-session-message>')).toBeUndefined()
  })

  it('buildReply 构造回发消息(from 填对方地址)', () => {
    const reply = buildReply(
      { msgId: 'af27935e-6c00-6e49-0228-3038191e06c3', from: 'uds:/tmp/cc-socks/13079.sock', text: '回', fromName: undefined },
      '收到!',
    )
    const parsed = JSON.parse(reply)
    expect(parsed.msg_id).toBe('r-af27935e-6c00-6e49-0228-3038191e06c3')
    expect(parsed.type).toBe('user')
    expect(parsed.message.content).toBe('收到!')
    expect(parsed.from).toBe('uds:/tmp/cc-socks/13079.sock')
  })

  it('udsPathOf 剥掉 uds: 前缀', () => {
    expect(udsPathOf('uds:/tmp/cc-socks/1.sock')).toBe('/tmp/cc-socks/1.sock')
    expect(udsPathOf('/tmp/cc-socks/1.sock')).toBeNull()
  })
})
