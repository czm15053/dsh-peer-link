# dsh-peer-link

点对点消息工具:让 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)(dsh)会话与其他本机 agent 会话(如 Claude Code)通过 unix socket 互发消息。

## 特性

- **单 peer 注册**:dsh 进程注册为一个 peer(`dsh-<pid>`),Claude Code 的 ListAgents/SendMessage 可直接发现并回复
- **会话标识 + 内部转发**:dsh 的每个会话有独立短 id,消息带 `@dsh-<pid>:<session>` 标识,Claude 回复时带标识,dsh 内部转发到对应会话
- **收消息**:收到 peer 消息 → 以用户消息气泡注入对应 dsh 会话(web 可见)
- **发消息**:`peer_send` 工具把消息写回对方 socket
- **列 peer**:`peer_list` 工具列出活跃 peer(按目录筛选、按创建时间排序)
- **交互式 peer_list**:前端 toolview 渲染成可点击卡片(排序/搜索/弹窗发送/刷新)
- **会话上下文**:每个 peer 显示首句(会话主题),一眼看懂在做什么

## 演示

**Claude 会话间通信**

![Claude 会话通信](docs/images/demo.gif)

## 截图

**交互式 peer_list:列出活跃 peer,支持排序/搜索/刷新**

![peer_list](docs/images/peer-list.png)

**点击 peer 弹窗直接发送消息**

![发送消息弹窗](docs/images/peer-send-dialog.png)

**两个会话轮流报数(连通性测试)**

![轮流报数](docs/images/counting-demo.png)

**两个会话玩成语接龙**

![成语接龙](docs/images/idiom-game.png)

## 架构

```
┌──────────────┐          ┌───────────────────────────────┐
│  Claude Code │          │  dsh (单 peer: dsh-<pid>)      │
│              │          │  ┌─ 会话 A (短id: abc12345)    │
│  ListAgents  │          │  └─ 会话 B (短id: def67890)    │
│  SendMessage │◀────────▶│  收到回复 → 按标识转发到对应会话 │
└──────────────┘          └───────────────────────────────┘
```

## 安装

```bash
# 从 GitHub
dsh plugin --profile web add "github:czm15053/dsh-peer-link"

# 或从本地仓库
dsh plugin --profile web add link:<repo路径>

dsh --profile web
```

## 工具

| 工具 | 作用 |
|---|---|
| `peer_send` | 向 peer 发消息。target 传入站消息编号 / peer 名 / socket 路径 |
| `peer_list` | 列出活跃 peer。可选 cwd 按目录筛选 |

## 配置

### dsh 侧(插件配置)

```yaml
- insert:
    - id: peer-link
      name: '@deepseek-ai/dsh-peer-link'
      config:
        targetSessionId: active   # 'active'=最近活跃 / 具体sessionId / 'all'
        name: my-dsh              # 注册名,默认 dsh-<pid>
        injectInbound: true       # 收消息注入会话
        registerTool: true        # 注册 peer_send/peer_list
```

### Claude Code 侧(官方跨 session 配置)

Claude Code 2.1.224+ 原生支持跨 session 消息。需在 `~/.claude/settings.json` 里配置:

1. **升级**:`claude update` 升级到 2.1.224+
2. **启用开关**:在 `env` 块加 `"CLAUDE_CODE_HARBOR_KITE": "1"`(绕过 feature flag)
3. **免审批**(推荐):加 `"crossSessionInbound": "accept"`(不加则消息先 hold 等待确认)

```json
{
  "env": {
    "CLAUDE_CODE_HARBOR_KITE": "1"
  },
  "crossSessionInbound": "accept"
}
```

配置后,每个 Claude 会话会在 `/tmp/cc-socks/` 生成一个 socket 文件(0600 权限)。

#### 与 dsh 会话通信

- **发现**:Claude Code 里用 `ListAgents` 列出所有 peer 会话(含 `dsh-<pid>`)
- **回复 dsh**:用 `SendMessage` 发给 `to: "dsh-<pid> [ref]"`,消息开头带上会话标识 `@dsh-<pid>:<session短id>`,dsh 会转发到对应会话
- **收 dsh 消息**:dsh 发来的消息会作为用户消息出现在 Claude 会话(带 `📨 [peer]` 标记)

## 构建与测试

```bash
cd dsh-peer-link
npm install
npm run build   # tsc → lib/ + tsdown → lib/client.js
npm test        # vitest
```

## 目录结构

```
dsh-peer-link/
├── src/
│   ├── index.ts              # host 插件:注册单 peer + 会话转发 + 工具
│   ├── protocol.ts           # socket 消息协议(NDJSON 解析/构造)
│   ├── peer-registry.ts      # peer 注册表(注册 + 发现 + 存活探测)
│   └── client/               # 前端半区
│       ├── index.ts          # toolview slot 注册 + onSend/onRefresh
│       └── PeerListTool.tsx  # 交互式 peer_list toolview
└── LICENSE                   # MIT
```

## 通信礼仪

- 收到 peer 消息时,注入格式附带提示:寒暄/确认类消息无需回复,有实际协作需求再回复
- 多 dsh 会话并发向同一 peer 发消息时,醒目的会话标识让 Claude 能区分各会话

## 友链

- [LinuxDo](https://linux.do) — 一个开放、分享的社区

## License

[MIT](LICENSE)
