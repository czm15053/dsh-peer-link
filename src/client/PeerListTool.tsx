/**
 * peer_list 工具的交互式 toolview。
 *
 * 当模型调用 peer_list 后,前端把结果渲染成 peer 卡片列表:
 *   - 按创建时间逆序排序
 *   - 每项显示名字、目录(缩写)、pid、本机标记
 *   - 只显示活跃 peer(后端已过滤)
 *   - 点击 peer 弹窗输入消息,发送后引导模型用 peer_send 转发
 *   - 顶部搜索框可快速筛选
 *
 * 仅从已记录的 tool 调用/结果派生(与 ui-skill 的 SkillRow 一致),保证可重放。
 */

import { useMemo, useState, type ChangeEvent, type CSSProperties } from 'react'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'

/** peer_list 工具输出的结构化 peer。 */
export interface PeerEntry {
  name: string
  pid: number
  cwd?: string
  time?: string
  self?: boolean
  /** 会话上下文提示(最近一条用户消息)。 */
  preview?: string
}

/** inject 工厂注入的业务面:onSend(target, text) 发消息,onRefresh() 刷新列表。 */
export interface PeerListInject {
  onSend: (target: string, text: string) => void
  onRefresh: () => void
}

/** 从工具结果块提取 peers。优先用 presentationMeta 持久化的 meta。 */
function peersOf(block: ToolCallViewProps['block']): PeerEntry[] {
  if (!('kind' in block)) return []
  const meta = block.meta as { peers?: PeerEntry[] } | undefined
  if (meta && Array.isArray(meta.peers)) return meta.peers
  for (const item of block.content) {
    if (item.type !== 'text') continue
    try {
      const parsed = JSON.parse(item.text) as { peers?: PeerEntry[] }
      if (Array.isArray(parsed.peers)) return parsed.peers
    } catch {
      // 文本可能不是 JSON(渲染文本),忽略
    }
  }
  return []
}

/** 解析创建时间戳(ms)用于排序。返回 number 或 0。 */
function timeMs(peer: PeerEntry): number {
  if (!peer.time) return 0
  const t = Date.parse(peer.time)
  return Number.isNaN(t) ? 0 : t
}

/** 相对时间:"刚刚" / "X分钟前" / "X小时前" / 具体日期。 */
function relativeTime(timeStr: string | undefined): string {
  if (!timeStr) return ''
  const t = Date.parse(timeStr)
  if (Number.isNaN(t)) return timeStr.slice(5, 16)
  const diff = Date.now() - t
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}天前`
  return timeStr.slice(0, 10)
}

/** 目录缩写:取最后 1-2 段,超长省略中间。 */
function shortCwd(cwd: string | undefined): string {
  if (!cwd) return '?'
  const parts = cwd.split('/').filter(Boolean)
  if (parts.length <= 2) return cwd
  const tail = parts.slice(-2).join('/')
  return `…/${tail}`
}

/** 内联样式(避免 CSS 模块构建链)。 */
const styles: Record<string, CSSProperties> = {
  card: {
    border: '1px solid var(--dsw-alias-border-l2, #d0d7de)',
    borderRadius: 10,
    padding: '6px 0',
    maxHeight: 400,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
  },
  header: {
    padding: '6px 12px 8px',
    borderBottom: '1px solid var(--dsw-alias-border-l1, #eef1f4)',
  },
  headerRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 6,
  },
  hint: { fontSize: 11, color: 'var(--dsw-alias-label-tertiary, #57606a)' },
  searchWrap: { position: 'relative', display: 'flex', alignItems: 'center' },
  searchInput: {
    width: '100%',
    padding: '5px 10px',
    border: '1px solid var(--dsw-alias-border-l2, #d0d7de)',
    borderRadius: 6,
    fontSize: 12,
    background: 'transparent',
    color: 'inherit',
    outline: 'none',
  },
  list: { flex: 1, overflowY: 'auto' },
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '7px 12px',
    cursor: 'pointer',
    border: 'none',
    background: 'transparent',
    width: '100%',
    textAlign: 'left',
    fontSize: 13,
    lineHeight: 1.4,
    color: 'inherit',
  },
  rowHover: { background: 'var(--dsw-alias-interactive-bg-hover, #f6f8fa)' },
  name: { fontWeight: 600, flex: 'none' },
  cwd: { color: 'var(--dsw-alias-label-tertiary, #57606a)', fontSize: 11, flex: 'none', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  time: { color: 'var(--dsw-alias-label-tertiary, #57606a)', fontSize: 11, flex: 'none' },
  selfTag: {
    background: 'var(--dsw-alias-state-info-bg, #ddf4ff)',
    color: 'var(--dsw-alias-state-info-primary, #0969da)',
    borderRadius: 6,
    padding: '0 5px',
    fontSize: 10,
    flex: 'none',
  },
  empty: { padding: '14px 12px', fontSize: 12, color: 'var(--dsw-alias-label-tertiary, #57606a)', textAlign: 'center' },
  // 发送弹窗
  modalBody: { display: 'flex', flexDirection: 'column', gap: 10, minWidth: 320 },
  modalTarget: { fontSize: 12, color: 'var(--dsw-alias-label-secondary, #57606a)' },
  modalInput: {
    width: '100%',
    padding: '8px 10px',
    border: '1px solid var(--dsw-alias-border-l2, #d0d7de)',
    borderRadius: 6,
    fontSize: 13,
    background: 'transparent',
    color: 'inherit',
    outline: 'none',
    fontFamily: 'inherit',
    resize: 'vertical',
    minHeight: 70,
  },
  modalFooter: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  status: { fontSize: 11, padding: '4px 12px', color: 'var(--dsw-alias-state-info-primary, #0969da)' },
}

/**
 * 渲染 peer 列表卡片(可交互)。
 * @param props - toolview 运行时 props + inject 注入的 onSend。
 */
export function PeerListTool(props: ToolCallViewProps & Partial<PeerListInject>) {
  const { block, onSend, onRefresh } = props
  const peers = useMemo(() => peersOf(block), [block])
  // 按创建时间逆序(最新在前)。
  const sorted = useMemo(() => [...peers].sort((a, b) => timeMs(b) - timeMs(a)), [peers])
  const [query, setQuery] = useState('')
  const [compose, setCompose] = useState<PeerEntry | null>(null)
  const [message, setMessage] = useState('')
  const [hoverPid, setHoverPid] = useState<number | undefined>(undefined)
  const [sent, setSent] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const doRefresh = (): void => {
    setRefreshing(true)
    onRefresh?.()
    // 3 秒后重置刷新状态(模型重新调用 peer_list 会生成新 toolview,本组件会替换)。
    setTimeout(() => setRefreshing(false), 3000)
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return sorted
    const q = query.trim().toLowerCase()
    return sorted.filter((p) => p.name.toLowerCase().includes(q) || (p.cwd ?? '').toLowerCase().includes(q))
  }, [sorted, query])

  const openCompose = (peer: PeerEntry): void => {
    // 当前会话 peer 不能给自己发消息,提示而不是打开发送。
    if (peer.self === true) {
      setSent('这是当前会话,不能给自己发消息。选择其他 peer 发送。')
      return
    }
    setCompose(peer)
    setMessage('')
    setSent(null)
  }

  const doSend = (): void => {
    if (!compose || !message.trim()) return
    onSend?.(compose.name, message.trim())
    setSent(`已提交给模型,将用 peer_send 转发给 ${compose.name}`)
    setCompose(null)
    setMessage('')
  }

  if (peers.length === 0) {
    return (
      <div style={styles.card} data-peer-list-tool>
        <div style={styles.empty}>暂无活跃 peer</div>
        <div style={{ padding: '8px 12px', display: 'flex', justifyContent: 'center' }}>
          <button
            type="button"
            onClick={doRefresh}
            disabled={refreshing}
            style={{
              fontSize: 12,
              padding: '5px 14px',
              border: '1px solid var(--dsw-alias-border-l2, #d0d7de)',
              borderRadius: 6,
              background: 'transparent',
              cursor: refreshing ? 'default' : 'pointer',
              color: 'inherit',
            }}
          >
            {refreshing ? '刷新中…' : '🔄 刷新'}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div style={styles.card} data-peer-list-tool>
      <div style={styles.header}>
        <div style={styles.headerRow}>
          <span style={styles.hint}>活跃 peers {peers.length} 个(最新在前)</span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={doRefresh}
            disabled={refreshing}
            style={{
              fontSize: 11,
              padding: '3px 8px',
              border: '1px solid var(--dsw-alias-border-l2, #d0d7de)',
              borderRadius: 6,
              background: 'transparent',
              color: refreshing ? 'var(--dsw-alias-label-tertiary, #57606a)' : 'inherit',
              cursor: refreshing ? 'default' : 'pointer',
            }}
            title="重新调用 peer_list 刷新列表"
          >
            {refreshing ? '刷新中…' : '🔄 刷新'}
          </button>
        </div>
        <div style={styles.searchWrap}>
          <input
            style={styles.searchInput}
            placeholder="🔍 搜索名字或目录…"
            value={query}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setQuery(e.currentTarget.value)}
          />
        </div>
      </div>
      <div style={styles.list}>
        {filtered.length === 0 && <div style={styles.empty}>无匹配 peer</div>}
        {filtered.map((peer) => {
          const isHover = hoverPid === peer.pid
          return (
            <div key={peer.pid} style={{ borderTop: '1px solid var(--dsw-alias-border-l1, #f6f8fa)' }}>
              <button
                type="button"
                style={{
                  ...styles.row,
                  ...(isHover ? styles.rowHover : {}),
                  flexDirection: 'column',
                  alignItems: 'stretch',
                  gap: 2,
                }}
                onMouseEnter={() => setHoverPid(peer.pid)}
                onMouseLeave={() => setHoverPid(undefined)}
                onClick={() => openCompose(peer)}
                title={`${peer.name} — ${peer.cwd ?? ''}`}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: 'var(--dsw-alias-state-success-primary, #1a7f37)',
                      flex: 'none',
                      display: 'inline-block',
                    }}
                    title="在线"
                  />
                  <span style={styles.name}>{peer.name}</span>
                  {peer.self === true && <span style={styles.selfTag}>当前会话</span>}
                  <span style={{ flex: 1 }} />
                  <span style={styles.cwd}>{shortCwd(peer.cwd)}</span>
                  <span style={styles.time}>{relativeTime(peer.time)}</span>
                  <span style={{ fontSize: 12, color: isHover ? 'var(--dsw-alias-state-info-primary, #0969da)' : 'transparent' }}>
                    ✉️
                  </span>
                </div>
                {peer.preview !== undefined && peer.preview !== '' && (
                  <div
                    style={{
                      paddingLeft: 16,
                      fontSize: 11,
                      color: 'var(--dsw-alias-label-tertiary, #57606a)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    💬 {peer.preview}
                  </div>
                )}
              </button>
            </div>
          )
        })}
      </div>
      {sent !== null && <div style={styles.status}>✓ {sent}</div>}

      {/* 发送弹窗 */}
      {compose !== null && (
        <Modal
          open
          onClose={() => setCompose(null)}
          title={`发送消息给 ${compose.name}`}
          closeLabel="关闭"
          description={compose.cwd ?? ''}
        >
          <div style={styles.modalBody}>
            <div style={styles.modalTarget}>
              收件人: <b>{compose.name}</b> (pid {compose.pid})
              {compose.self === true ? ' · 当前会话' : ''}
            </div>
            <textarea
              style={styles.modalInput}
              value={message}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setMessage(e.currentTarget.value)}
              placeholder="输入要发送的消息…"
              autoFocus
            />
            <div style={styles.modalFooter}>
              <Button variant="ghost" onClick={() => setCompose(null)}>取消</Button>
              <Button variant="primary" disabled={!message.trim()} onClick={doSend}>发送</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  )
}
