/**
 * dsh-peer-link — host 插件。
 *
 * 独立点对点通信工具:让 dsh 会话与其他本机 agent 会话(如 Claude Code)通过
 * unix socket 互发消息。
 *
 * 每个 dsh 会话(session)注册为**独立 peer**(dsh-<pid>-<session短id>),
 * 绑定独立 socket,收到消息注入对应会话。
 *
 *   - 注册:agent/created → 为该会话注册 peer(独立名字 + socket)
 *   - 入站:每个 peer 的 socket 收消息 → 注入对应的 dsh 会话
 *   - 出站:peer_send 工具发消息;peer_list 工具列活跃 peer
 *
 * 纯 host 插件。挂载:dsh plugin --profile web add link:<repo>/dsh-peer-link
 * @module dsh-peer-link
 */

import { createServer, type Socket } from 'node:net'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool, type JsonValue } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { buildReply, parsePeerMessage, udsPathOf, type PeerMessage } from './protocol.js'
import { listPeers, readPeerPreview, register, resolveDshWorkspaceCwd, SESSION_DIR, SOCK_DIR, unregister } from './peer-registry.js'

/** 稳定 cordis 插件名。 */
export const name = 'peer-link'

/** 需要的服务。 */
export const inject = ['agents', 'tools', 'systemPrompt']

/** system-prompt 段序。 */
const SECTION_ORDER = 150

/** 模型可读的插件宣告:存在、能力、限制。 */
export const PEER_LINK_GUIDANCE = `本机已安装 dsh-peer-link 插件(点对点消息工具)。
能力:dsh 注册为单个 peer(dsh-<pid>),可通过 peer_send 向其他本机会话发送消息(target 传 peer_list 列出的名字);收到对方消息会作为用户消息进入本会话。
回复:对方发来的消息以「📨 [peer] 发送者 说:」形式出现,回复时用 peer_send,target 传对方 peer 名。
礼仪:有事说事,不寒暄。对方只是问候/确认/寒暄时,不必回复;有实际协作需求或对方在等回应时再回复。
列会话:调用 peer_list 可列出活跃 peer(按创建时间从新到旧),传 cwd 参数可按工作目录筛选。
限制:点对点单聊;对方需允许接收 socket 消息。用户提到「peer / 发消息 / 列会话 / socket」时即指本插件。`

/** 插件配置。 */
export interface Config {
  /** 注册名前缀。默认 dsh-<pid>-<session短id>。 */
  name?: string
  /** 注册目录。默认 ~/.claude/sessions。 */
  sessionDir?: string
  /** socket 目录。默认 /tmp/cc-socks。 */
  sockDir?: string
  /** 入站消息是否注入会话。默认 true。 */
  injectInbound?: boolean
  /** 是否注册 peer_send/peer_list 工具。默认 true。 */
  registerTool?: boolean
  /** 工作目录兜底。 */
  workspaceDir?: string
  /**
   * 定向注入:指定接收 peer 消息的会话 id。
   * 默认 'active'(最近活跃);具体 session id 只注入该会话;'all' 全注入。
   */
  targetSessionId?: string | 'active' | 'all'
}

/** peer_list 输出的一条 peer 信息(结构化,供前端 toolview 渲染)。 */
export interface PeerInfo {
  name: string
  pid: number
  cwd?: string
  time?: string
  self?: boolean
  /** 会话上下文提示(首句)。 */
  preview?: string
}

/** 由 node:net 建 socket server,把每行消息交给 handler。 */
export function createPeerServer(handler: (msg: PeerMessage, raw: string) => void) {
  return createServer((conn: Socket) => {
    let buf = ''
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl: number
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (line === '') continue // 空行 = 探测
        const msg = parsePeerMessage(line)
        if (msg) handler(msg, line)
        else console.warn('[peer-link] 忽略非 user 消息:', line.slice(0, 100))
      }
    })
    conn.on('error', () => { /* 忽略断开 */ })
  })
}

/**
 * 一个 dsh 会话的标识映射(单 peer 架构下,用于消息转发)。
 */
interface SessionTag {
  /** 会话 id(agent.id)。 */
  sessionId: string
  /** 短 id,用于消息里标识会话。 */
  shortId: string
}

/** 注册 host 半区。 */
export function apply(ctx: Context, config?: Config): void {
  const pid = process.pid
  const resolvedConfig = config ?? {}
  const sessionDir = resolvedConfig.sessionDir ?? SESSION_DIR
  const sockDir = resolvedConfig.sockDir ?? SOCK_DIR
  const namePrefix = resolvedConfig.name ?? `dsh-${pid}`
  const mainSockPath = `${sockDir}/${pid}.sock`

  // 活跃 dsh session 的短 id 映射(用于消息里标识会话 + 内部转发)。
  const sessionTags = new Map<string, SessionTag>()

  /** 从 session id 派生出短 id。 */
  function shortIdOf(agentId: string): string {
    const raw = agentId.replace(/^session-/, '')
    return /^[0-9a-f-]{20,}$/.test(raw) ? raw.slice(0, 8) : raw
  }

  // ---- 出站:以 dsh 进程身份发消息,带会话标识 ----
  async function sendAs(sessionId: string, targetFrom: string, text: string, replyToMsgId: string): Promise<void> {
    const targetPath = udsPathOf(targetFrom) ?? targetFrom
    const tag = sessionTags.get(sessionId)
    const shortId = tag?.shortId ?? 'main'
    // 带跨 session 包装 + 醒目的会话来源标识 + 回复指引。
    // 会话标识放在最前面且用 @ 格式,让 Claude 一眼看到是哪个 dsh 会话,
    // 避免多个 dsh 会话混发时 Claude 分不清。
    const replyContent = [
      `<cross-session-message from="uds:${mainSockPath}" from-name="${namePrefix}">`,
      `[会话 @${namePrefix}:${shortId}]`,
      text.trim(),
      ``,
      `[这是 dsh 会话 "${shortId}" 发给你的消息。要回复这个会话:`,
      `用 SendMessage 发给 "${namePrefix}",并在消息开头带上 "@${namePrefix}:${shortId}"。`,
      `如果你同时收到多个不同会话的消息,请分别用各自的标识回复对应会话。]`,
      `</cross-session-message>`,
    ].join('\n')
    const reply = buildReply(
      { msgId: replyToMsgId, from: targetFrom, text: replyContent, fromName: undefined },
      replyContent,
    )
    const { connect } = await import('node:net')
    await new Promise<void>((resolve, reject) => {
      const out = connect(targetPath)
      const timer = setTimeout(() => {
        out.destroy()
        reject(new Error(`send timeout: ${targetPath}`))
      }, 5000)
      out.on('error', (e) => { clearTimeout(timer); reject(e) })
      out.on('connect', () => {
        out.write(reply, () => { clearTimeout(timer); resolve() })
        out.end()
      })
    })
  }

  // ---- 入站:收到消息 → 按会话标识转发到对应 agent ----
  async function injectInbound(msg: PeerMessage): Promise<void> {
    // 忽略来自 dsh 自身的消息,防回显。
    if (udsPathOf(msg.from) === mainSockPath) {
      console.warn('[peer-link] 忽略来自自身的消息:', msg.text.slice(0, 60))
      return
    }
    const agents = ctx.agents.list()
    if (agents.length === 0) {
      console.warn('[peer-link] 无活跃会话,消息未注入:', msg.text.slice(0, 80))
      return
    }
    // 从消息内容解析目标会话短 id。支持两种格式:
    // 新格式 "@dsh-<pid>:<shortId>" 和旧格式 "会话 <shortId>"。
    const shortMatch = msg.text.match(/@[\w-]+:([0-9a-f]{6,8})/) ?? msg.text.match(/会话\s+([0-9a-f]{6,8})/)
    let target: Agent | undefined
    if (shortMatch) {
      const short = shortMatch[1]!
      target = agents.find((a) => shortIdOf(a.id) === short)
    }
    // 无匹配则注入最近活跃会话。
    if (!target) {
      target = selectTargetAgents(agents, resolvedConfig.targetSessionId)[0]
    }
    if (!target) {
      console.warn('[peer-link] 无匹配目标会话,消息未注入:', msg.text.slice(0, 80))
      return
    }
    const sender = msg.fromName ?? await peerDisplayName(msg.from, sessionDir)
    const labeled = [
      `📨 [peer] ${sender} 说:`,
      ``,
      msg.text.trim(),
      ``,
      `(若这条消息只是寒暄/确认/问候,无需回复;若需要协作或对方在等回应,用 peer_send 回复)`,
    ].join('\n')
    const message = createUserMessage({
      content: [{ type: 'text', text: labeled }],
      source: { kind: 'user' },
    })
    // followup() 唤醒会话,消息作为正式对话轮次进入对话流。
    target.followup(message)
  }

  // ---- 单 socket server(所有 Claude 消息到这一个)----
  const server = createPeerServer((msg) => {
    if (resolvedConfig.injectInbound ?? true) void injectInbound(msg)
  })

  // ---- 注册单 peer + 监听 ----
  ctx.effect(async () => {
    const firstCwd = firstAgentCwd(ctx) ?? resolvedConfig.workspaceDir ?? await resolveDshWorkspaceCwd()
    const regPath = await register(pid, mainSockPath, namePrefix, sessionDir, firstCwd)
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(mainSockPath, () => { server.off('error', reject); resolve() })
    })
    console.log(`[peer-link] 已注册 ${regPath}(cwd=${firstCwd ?? process.cwd()}),监听 ${mainSockPath}`)

    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unregister(pid, mainSockPath, sessionDir)
      console.log('[peer-link] 已清理')
    }
  }, 'peer-link.serve')

  // ---- 生命周期:维护 session 短 id 映射(用于消息标识和转发)----
  ctx.on('agent/created', ({ agent }) => {
    sessionTags.set(agent.id, { sessionId: agent.id, shortId: shortIdOf(agent.id) })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    sessionTags.delete(agent.id)
  })

  // ---- peer_send 工具:发消息给 peer ----
  if (resolvedConfig.registerTool ?? true) {
    const peerSend = defineTool({
      name: 'peer_send',
      description: '向另一个本机会话(peer)发送一条消息。' +
        'target 传:peer 名(见 peer_list)、或 socket 路径。' +
        '入站消息以「📨 [peer] 发送者 说:」出现,回复时 target 传对方 peer 名。',
      parameters: {
        target: { type: 'string', description: '目标:peer 名 / socket 路径' },
        text: { type: 'string', description: '要发送的消息文本' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            sent: { type: 'boolean', required: true },
            target: { type: 'string' },
          },
        },
        render: (_args, value: { sent?: boolean; target?: string }) => {
          return textBlocks(value.sent ? `✓ 已发送到 ${value.target}` : `✗ 发送失败: ${value.target}`)
        },
      },
      execute: async (args: { target: string; text: string }, exec): Promise<{ sent: boolean; target: string }> => {
        // 用调用工具的 agent 的 sessionId 作为发送身份(单 peer,消息带会话标识)。
        const fromSessionId = exec.agent?.id
        const livePeers = await listPeers(sessionDir)
        const peer = livePeers.find((p) => p.socketPath === args.target || p.name === args.target)
        const targetFrom =
          (peer ? `uds:${peer.socketPath}` : undefined) ??
          (args.target.startsWith('/') ? `uds:${args.target}` : undefined)
        if (!targetFrom) {
          return { sent: false, target: `unknown target: ${args.target}` }
        }
        // 不能发给自己(dsh 单 peer 的 socket)。
        if (udsPathOf(targetFrom) === mainSockPath) {
          return { sent: false, target: `${targetFrom} (不能发给自己)` }
        }
        try {
          await sendAs(fromSessionId ?? '', targetFrom, args.text, '')
          return { sent: true, target: targetFrom }
        } catch (e) {
          return { sent: false, target: `${targetFrom}: ${(e as Error).message}` }
        }
      },
    })
    ctx.effect(() => {
      const dispose = ctx.tools.register(peerSend)
      console.log('[peer-link] ✓ peer_send 已注册')
      return () => dispose()
    }, 'peer-link.tool.send')

    // ---- peer_list 工具:列出活跃 peer ----
    const peerList = defineTool({
      name: 'peer_list',
      description: '列出活跃的本机会话(peer),按创建时间从新到旧。' +
        '可选参数 cwd:按工作目录筛选(子串匹配)。当用户问「有哪些会话 / 列 peer / 当前目录下的会话」时使用。',
      parameters: {
        cwd: { type: 'string', description: '按工作目录筛选(子串匹配)。空则列出全部。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            cwd: { type: 'string' },
            peers: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  pid: { type: 'integer', required: true },
                  cwd: { type: 'string' },
                  time: { type: 'string' },
                  self: { type: 'boolean' },
                  preview: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value: { cwd?: string; peers?: PeerInfo[] }) => {
          const lines = [`筛选目录: ${value.cwd || '(全部)'}`]
          lines.push(`活跃 peers(${(value.peers ?? []).length},最新→最旧):`)
          lines.push(...(value.peers ?? []).map((p) => {
            const tag = p.self ? '(当前会话)' : ''
            const preview = p.preview ? ` | 最近: ${p.preview}` : ''
            return `  - ${p.name} (pid=${p.pid}, ${p.cwd ?? '?'}, ${p.time ?? '?'})${tag}${preview}`
          }))
          return textBlocks(lines.join('\n'))
        },
        // 结构化数据持久化到 session log 的 meta,供前端 toolview 渲染。
        presentationMeta: (_args: { cwd?: string }, value: { cwd?: string; peers?: PeerInfo[] }) => {
          return { cwd: value.cwd ?? '', peers: value.peers ?? [] } as unknown as JsonValue
        },
      },
      execute: async (args: { cwd?: string }, exec): Promise<{ cwd?: string; peers: PeerInfo[] }> => {
        const filter = (args.cwd ?? '').trim()
        const livePeers = await listPeers(sessionDir)
        const filtered = filter ? livePeers.filter((p) => (p.cwd ?? '').includes(filter)) : livePeers
        // 并发读取每个 peer 的会话上下文提示(首句)。
        const previews = await Promise.all(filtered.map(async (p) => {
          try {
            return await readPeerPreview(p)
          } catch {
            return undefined
          }
        }))
        // 单 peer 架构:dsh 是一个 peer(dsh-<pid>)。当前会话通过 exec.agent 判断,
        // 标记 dsh peer 为"当前会话"。
        const currentSessionId = exec.agent?.id
        const currentShortId = currentSessionId ? shortIdOf(currentSessionId) : undefined
        const peers = filtered.map((p, i) => {
          // dsh 单 peer:如果当前是 dsh 会话,把 dsh peer 标为当前会话。
          const isDshPeer = p.socketPath === mainSockPath
          const isCurrent = currentSessionId !== undefined && isDshPeer
          // 名字:若是 dsh peer,带上当前会话短 id 供区分。
          const displayName = isDshPeer && currentShortId ? `${p.name} (会话 ${currentShortId})` : p.name
          return {
            name: displayName,
            pid: p.pid,
            cwd: p.cwd ?? '',
            time: p.startedAt ? new Date(p.startedAt).toLocaleString('zh-CN', { hour12: false }) : '',
            self: isCurrent,
            preview: previews[i] ?? '',
          }
        })
        return { cwd: filter || '', peers }
      },
    })
    ctx.effect(() => {
      const dispose = ctx.tools.register(peerList)
      console.log('[peer-link] ✓ peer_list 已注册')
      return () => dispose()
    }, 'peer-link.tool.list')
  }

  // ---- system-prompt 宣告 ----
  ctx.effect(() => {
    const dispose = ctx.systemPrompt.section({
      name: 'plugin:peer-link',
      order: SECTION_ORDER,
      text: PEER_LINK_GUIDANCE,
    })
    return () => dispose()
  }, 'peer-link.prompt')

  // ---- 全局 teardown:插件卸载/进程退出时清理单 peer ----
  ctx.effect(() => {
    return async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unregister(pid, mainSockPath, sessionDir)
      console.log('[peer-link] 已清理单 peer')
    }
  }, 'peer-link.teardown')
}

function textBlocks(text: string): ContentBlock[] {
  return [{ type: 'text', text }]
}

/**
 * 把 socket 路径转成可读的 peer 名。反查注册表拿真实名字,否则用 pid 推断。
 */
async function peerDisplayName(from: string, sessionDir: string): Promise<string> {
  const path = udsPathOf(from) ?? from
  const pid = path.split('/').pop()?.replace('.sock', '')
  if (!pid) return from
  const live = await listPeers(sessionDir, false)
  const rec = live.find((p) => String(p.pid) === pid || p.socketPath === path)
  return rec?.name ?? `peer-${pid}`
}

/** 取首个活跃 agent 的会话工作目录。 */
function firstAgentCwd(ctx: Context): string | undefined {
  const agents = ctx.agents.list()
  for (const agent of agents) {
    const header = (agent.session ?? {}) as { meta?: { cwd?: string }; cwd?: string }
    const cwd = header.meta?.cwd ?? header.cwd
    if (typeof cwd === 'string' && cwd !== '') return cwd
  }
  return undefined
}

/**
 * 选出定向注入的目标 agent。
 * - target='all' → 全部活跃 agent
 * - target=具体 sessionId → 匹配该会话的 agent(无则空)
 * - 默认 'active' → 最近活跃的 agent(按 session.seq 最大判断)
 */
function selectTargetAgents(agents: Agent[], target?: string): Agent[] {
  if (!target || target === 'active') {
    if (agents.length === 0) return []
    return [...agents].sort((a, b) => agentSeq(b) - agentSeq(a)).slice(0, 1)
  }
  if (target === 'all') return [...agents]
  const hit = agents.find((a) => a.id === target)
  return hit ? [hit] : []
}

/** 取 agent 会话的当前 seq(活动程度)。 */
function agentSeq(agent: Agent): number {
  const session = agent.session as unknown as { seq?: number }
  return typeof session.seq === 'number' ? session.seq : 0
}

// 供测试引用的工具。Agent 类型仅类型层面使用。
export type { Agent, PeerMessage }
