/**
 * dsh-peer-link — 浏览器半区。
 *
 * 注册 peer_list 工具的交互式 toolview:`tool.call.toolview` keyed slot
 * 的 key 为 'peer_list'。模型调用 peer_list 后,前端渲染成可点击的 peer 卡片列表。
 *
 * 通过 register 的 inject 工厂把 connection 的 api + sessions 的当前会话
 * 封装成 onSend 传给组件:点击 peer 弹窗输入消息后,注入一条消息到当前会话,
 * 让模型用 peer_send 转发给对方。
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ISessions } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle, PromptContentPart } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { PeerListTool, type PeerListInject } from './PeerListTool.js'

/** 需要的 client 服务。 */
export const inject = ['slots', 'connection', 'sessions']

/**
 * 注册 peer_list 的自定义 toolview。
 * @param ctx - client root context。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const connection = ctx.get('connection') as ConnectionHandle
    const sessions = ctx.get('sessions') as unknown as ISessions

    const promptCurrent = (instruction: string): void => {
      // 取当前选中的会话 id(如果没有则不发送)。
      const current = sessions.list.getSnapshot().current
      if (!current) {
        // eslint-disable-next-line no-console
        console.warn('[peer-link] 无当前会话,无法发送')
        return
      }
      const content: PromptContentPart[] = [{ type: 'text', text: instruction }]
      void connection.api.sessions.prompt({
        sessionId: current,
        mode: 'queue',
        content,
      }).catch((e: unknown) => {
        // eslint-disable-next-line no-console
        console.error('[peer-link] 提交指令失败:', e)
      })
    }

    // 发消息给 peer(引导模型用 peer_send 转发)。
    const onSend = (target: string, text: string): void => {
      promptCurrent(`请用 peer_send 工具向 peer「${target}」发送消息:\n\n${text}`)
    }
    // 刷新 peer 列表(引导模型重新调用 peer_list)。
    const onRefresh = (): void => {
      promptCurrent('请重新调用 peer_list 工具,刷新活跃 peer 列表。')
    }

    const dispose = ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: 'peer_list',
        inject: (): PeerListInject => ({ onSend, onRefresh }),
      },
      PeerListTool,
    )
    return () => dispose()
  }, 'peer-link: peer_list toolview')
}
