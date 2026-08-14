/**
 * 点对点 socket 消息协议(NDJSON 明文,逐行)。
 *
 * 线格式:
 *   - 投递:{"msgV":1,"msg_id":"...","type":"user",
 *             "message":{"role":"user","content":"<cross-session-message from=... from-name=...>文本</cross-session-message>"},
 *             "priority":"next","from":"uds:/tmp/cc-socks/xxx.sock"}
 *   - 回复:构造 {"type":"user","message":{"role":"user","content":"..."},"from":对方地址}
 * @module dsh-peer-link/protocol
 */

/** 一条入站消息。 */
export interface PeerMessage {
  /** 原消息 id。 */
  readonly msgId: string
  /** 原消息的 from(uds:/tmp/cc-socks/xxx.sock),用于回发。 */
  readonly from: string
  /** 剥掉 <cross-session-message> 包装后的用户可见文本。 */
  readonly text: string
  /** cross-session-message 的 from-name(对方注册名)。 */
  readonly fromName: string | undefined
}

/** 解析一行 NDJSON。非法行返回 null。 */
export function parsePeerMessage(line: string): PeerMessage | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const msg = raw as Record<string, unknown>
  if (msg.type !== 'user') return null
  const message = msg.message
  if (typeof message !== 'object' || message === null) return null
  const content = (message as Record<string, unknown>).content
  if (typeof content !== 'string') return null
  const from = typeof msg.from === 'string' ? msg.from : ''
  const msgId = typeof msg.msg_id === 'string' ? msg.msg_id : ''
  return {
    msgId,
    from,
    text: extractText(content),
    fromName: extractFromName(content),
  }
}

/** 剥掉 <cross-session-message> 包装,返回用户可见文本。 */
export function extractText(content: string): string {
  const m = content.match(/<cross-session-message[^>]*>([\s\S]*?)<\/cross-session-message>/)
  return (m ? m[1] : content).trim()
}

/** 取 cross-session-message 的 from-name(对方注册名);无则 undefined。 */
export function extractFromName(content: string): string | undefined {
  const m = content.match(/<cross-session-message[^>]*from-name="([^"]*)"[^>]*>/)
  return m ? m[1] : undefined
}

/**
 * 构造回发消息(NDJSON 行)。
 *
 * 注意协议语义:回复消息的 `from` 字段填 `original.from`(原发送方地址),
 * 而不是本方的地址 —— 与投递协议一致(每条消息的 from 是发送方)。
 * connect 目标是 `original.from` 去掉 `uds:` 前缀(见 buildPeerMessage 的调用方)。
 */
export function buildReply(original: PeerMessage, text: string): string {
  const msgId = `r-${original.msgId || '00000000-0000-0000-0000-000000000000'}`
  return JSON.stringify({
    msgV: 1,
    msg_id: msgId,
    type: 'user',
    message: { role: 'user', content: text },
    priority: 'next',
    from: original.from,
  }) + '\n'
}

/** 目标 socket 地址(去掉 uds: 前缀);非 uds: 返回 null。 */
export function udsPathOf(from: string): string | null {
  return from.startsWith('uds:') ? from.slice(4) : null
}
