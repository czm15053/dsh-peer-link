/**
 * Peer 注册表:把 dsh 会话注册进 ~/.claude/sessions 注册表,
 * 并扫描注册表发现可投递的活跃 peer。
 *
 *   - 注册:写 ~/.claude/sessions/<pid>.json(peerProtocol:1, kind:interactive, messagingSocketPath)
 *   - 发现:扫注册表目录读所有 *.json
 *
 * @module dsh-peer-link/peer-registry
 */

import { open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { connect } from 'node:net'

export const SESSION_DIR = join(homedir(), '.claude', 'sessions')
export const SOCK_DIR = '/tmp/cc-socks'

/**
 * 从 dsh 的 workspace 存储(~/.dsh/storages/workspace.json)读最近更新的 workspace 路径。
 * dsh host 是多会话宿主,没有单一 cwd;用最近活跃的 workspace 作为 peer 注册 cwd 的兜底。
 * 不存在/不可读返回 undefined。
 */
export async function resolveDshWorkspaceCwd(): Promise<string | undefined> {
  const workspaceJson = join(homedir(), '.dsh', 'storages', 'workspace.json')
  try {
    const raw = JSON.parse(await readFile(workspaceJson, 'utf8')) as {
      tables?: { workspaces?: Record<string, { path?: string; updatedAt?: string }> }
    }
    const workspaces = raw.tables?.workspaces
    if (!workspaces) return undefined
    // 找 updatedAt 最新的 workspace
    let best: { path?: string; updatedAt?: string } | undefined
    for (const ws of Object.values(workspaces)) {
      if (!ws?.path) continue
      if (!best || (ws.updatedAt ?? '') > (best.updatedAt ?? '')) best = ws
    }
    return best?.path
  } catch {
    return undefined
  }
}

/** 一条注册记录。 */
export interface PeerRecord {
  readonly pid: number
  readonly sessionId: string
  readonly name: string
  readonly socketPath: string
  readonly kind: string
  readonly peerProtocol: number
  /** 工作目录(cwd),来自注册文件。 */
  readonly cwd?: string
  /** 创建时间戳(ms),来自注册文件的 startedAt。 */
  readonly startedAt?: number
}

/**
 * 写注册文件,让 Claude 能发现本 peer。返回注册文件路径。
 * @param pid - 进程 pid。
 * @param sockPath - socket 路径。
 * @param name - 注册名(如 dsh-<pid> 或 dsh-<pid>-<session短id>)。
 * @param sessionDir - 注册目录。
 * @param cwd - 工作目录。
 * @param sessionId - 会话 id;缺省用 name。
 * @param fileKey - 注册文件名键;缺省用 pid。多个 peer 同进程时需传不同 key 避免覆盖。
 */
export async function register(
  pid: number,
  sockPath: string,
  name: string,
  sessionDir = SESSION_DIR,
  cwd?: string,
  sessionId?: string,
  fileKey?: string,
): Promise<string> {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(sessionDir, { recursive: true })
  const now = Date.now()
  const procStart = new Date().toString()
  const reg = {
    pid,
    sessionId: sessionId ?? name,
    // 优先传真实会话目录;否则用配置的 workspaceDir;最后兜底进程 cwd。
    cwd: cwd ?? process.cwd(),
    startedAt: now,
    procStart,
    version: '2.1.226',
    peerProtocol: 1,
    kind: 'interactive',
    entrypoint: 'cli',
    messagingSocketPath: sockPath,
    name,
    nameSource: 'derived',
    status: 'idle',
    updatedAt: now,
    statusUpdatedAt: now,
  }
  // 文件名:传了 fileKey 用 fileKey(避免同进程多 peer 覆盖),否则用 pid。
  const fname = fileKey !== undefined ? `${fileKey}.json` : `${pid}.json`
  const path = join(sessionDir, fname)
  await writeFile(path, JSON.stringify(reg, null, 2))
  return path
}

/** 退出时清理注册文件和 socket。fileKey 对应注册时的 fileKey。 */
export async function unregister(pid: number, sockPath: string, sessionDir = SESSION_DIR, fileKey?: number | string): Promise<void> {
  const fname = fileKey !== undefined ? `${fileKey}.json` : `${pid}.json`
  await Promise.all([
    rm(join(sessionDir, fname), { force: true }),
    rm(sockPath, { force: true }),
  ])
}

/**
 * 从注册文件路径解析 pid。
 * 文件名形如 <pid>.json 或 <pid>-<session短id>.json。
 */
export function pidOf(regPath: string): number | undefined {
  const base = regPath.split('/').pop() ?? ''
  const m = base.match(/^(\d+)(?:-[0-9a-f]+)?\.json$/)
  return m ? Number(m[1]) : undefined
}

/** 读取一条注册文件,非法/不存在返回 null。 */
export async function readPeer(regPath: string): Promise<PeerRecord | null> {
  const pid = pidOf(regPath)
  if (pid === undefined) return null
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(regPath, 'utf8'))
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const socketPath = rec.messagingSocketPath
  const name = rec.name
  if (typeof socketPath !== 'string' || socketPath === '') return null
  return {
    pid,
    sessionId: typeof rec.sessionId === 'string' ? rec.sessionId : String(pid),
    name: typeof name === 'string' ? name : String(pid),
    socketPath,
    kind: typeof rec.kind === 'string' ? rec.kind : 'interactive',
    peerProtocol: typeof rec.peerProtocol === 'number' ? rec.peerProtocol : 0,
    cwd: typeof rec.cwd === 'string' ? rec.cwd : undefined,
    startedAt: typeof rec.startedAt === 'number' ? rec.startedAt : undefined,
  }
}

/**
 * 探测 peer 的 socket 是否真实可连接(存活)。
 * Claude 探活用空连接;这里只 connect 一下,能连上说明进程在监听。
 */
export function isPeerAlive(socketPath: string, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect(socketPath)
    const timer = setTimeout(() => { sock.destroy(); resolve(false) }, timeoutMs)
    sock.once('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true) })
    sock.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

/**
 * 扫描注册表目录,返回所有可解析**且 socket 存活**的注册记录。
 * 按 startedAt 从新到旧排序;缺 startedAt 的排最后。
 */
export async function listPeers(sessionDir = SESSION_DIR, aliveOnly = true): Promise<PeerRecord[]> {
  let files: string[]
  try {
    files = await readdir(sessionDir)
  } catch {
    return []
  }
  const recs: (PeerRecord | null)[] = []
  for (const f of files) {
    // 支持 <pid>.json 和 <pid>-<session短id>.json。
    if (!/^\d+(?:-[0-9a-f]+)?\.json$/.test(f)) continue
    recs.push(await readPeer(join(sessionDir, f)))
  }
  const valid = recs.filter((r): r is PeerRecord => r !== null)
  // 并发探测存活(避免串行等待拖慢)。
  const aliveFlags = await Promise.all(valid.map((r) => (aliveOnly ? isPeerAlive(r.socketPath) : Promise.resolve(true))))
  const records: PeerRecord[] = valid.filter((_, i) => aliveFlags[i])
  records.sort((a, b) => {
    const ta = a.startedAt ?? 0
    const tb = b.startedAt ?? 0
    return tb - ta
  })
  return records
}

/** 从一条 user 消息提取可读文本;不可读返回 undefined。 */
function extractUserText(content: unknown): string | undefined {
  if (typeof content !== 'string' || content.trim() === '') return undefined
  let text = content.trim()
  // 剥掉跨 session 注入的包装,取核心文本。
  // 格式1:<cross-session-message ...>文本</cross-session-message>
  // 格式2:📨 [peer] X 说:...  (dsh 注入格式)
  // 格式3:Another Claude session sent a message:...
  // 格式4:<local-command-caveat>...</local-command-caveat>(系统注入)
  const m1 = text.match(/<cross-session-message[^>]*>([\s\S]*?)<\/cross-session-message>/)
  if (m1) text = m1[1]!.trim()
  const m2 = text.match(/📨 \[peer\][\s\S]*?\n([\s\S]+?)\n\s*\(编号/)
  if (m2) text = m2[1]!.trim()
  const m3 = text.match(/Another Claude session sent a message:\n?([\s\S]*)/)
  if (m3) text = m3[1]!.trim()
  // 跳过系统注入(<local-command-*>/<...> 标签开头)、命令、空内容。
  if (text === '' || text.startsWith('/') || text.startsWith('<local-command')) return undefined
  if (/^<[a-z-]+>/.test(text)) return undefined
  // 跳过纯操作提示。
  if (/^(已完成|收到|好的|OK|明白了|了解|done|ok|收到确认)/i.test(text) && text.length < 30) return undefined
  return text.slice(0, 100)
}

/** 从一组行解析出用户消息文本。顺序:按给定的索引顺序。 */
function firstUserText(lines: string[]): string | undefined {
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const rec = JSON.parse(trimmed) as { type?: string; message?: { content?: unknown } }
      if (rec.type !== 'user') continue
      const text = extractUserText(rec.message?.content)
      if (text) return text
    } catch {
      // 非 JSON 行,忽略
    }
  }
  return undefined
}

/** 读文件的一段(从 position 起 maxBytes 字节),返回 Buffer。 */
async function readChunk(historyPath: string, position: number, maxBytes: number): Promise<Buffer> {
  const fh = await open(historyPath, 'r')
  try {
    const buf = Buffer.alloc(maxBytes)
    const { bytesRead } = await fh.read(buf, 0, maxBytes, position)
    return bytesRead < maxBytes ? buf.subarray(0, bytesRead) : buf
  } finally {
    await fh.close()
  }
}

/**
 * 从 peer 的 Claude 会话历史(~/.claude/projects/<cwd编码>/<sessionId>.jsonl)
 * 提取一条用户消息,作为会话上下文提示。
 *
 * 策略:先读文件头部找**第一条**用户消息(首句 = 会话主题,最能看懂 peer
 * 在做什么);若头部找不到(如全是系统注入),回退读尾部找**最近一条**用户消息。
 */
export async function readPeerPreview(rec: PeerRecord): Promise<string | undefined> {
  // 整体超时保护(3 秒),避免读取异常文件挂起。
  return Promise.race([
    readPeerPreviewInner(rec),
    new Promise<string | undefined>((resolve) => setTimeout(() => resolve(undefined), 3000)),
  ])
}

/** readPeerPreview 的实际实现(带超时包装)。 */
async function readPeerPreviewInner(rec: PeerRecord): Promise<string | undefined> {
  if (!rec.cwd || !rec.sessionId) return undefined
  const enc = rec.cwd.split('/').join('-')
  const historyPath = join(homedir(), '.claude', 'projects', enc, `${rec.sessionId}.jsonl`)

  let size = 0
  try {
    size = (await stat(historyPath)).size
  } catch {
    return undefined
  }
  if (size === 0) return undefined

  // 1. 头部 256KB 找第一条用户消息(首句 = 会话主题)。
  const headBytes = Math.min(size, 256 * 1024)
  try {
    const head = await readChunk(historyPath, 0, headBytes)
    const lines = head.toString('utf8').split('\n')
    const first = firstUserText(lines)
    if (first) return first
  } catch {
    // 读取失败,继续尝试尾部
  }

  // 2. 尾部 256KB 反向找最近一条用户消息(兜底)。
  const tailBytes = Math.min(size, 256 * 1024)
  try {
    const tail = await readChunk(historyPath, size - tailBytes, tailBytes)
    const lines = tail.toString('utf8').split('\n')
    const last = firstUserText([...lines].reverse())
    if (last) return last
  } catch {
    // 读取失败
  }
  return undefined
}
