# 同在 · Tongzai

一个适合个人与小范围使用的双人语音互动网页。邀请一位伙伴，一起对话、共读或排练；两端共享提示卡、进度和计时，各自保留暂停、静音和离开的自由。

也可以创建单人练习房间，先熟悉模板与操作。

**在线体验：[同在 · 腾讯云入口](https://www.conanxin.com/tongzai/)** · [GitHub 源码](https://github.com/conanxin/tongzai)

网页、静态资源和房间 API 已完成国内无请求代理的访问检查。公网 TURN 入口仍待放通，跨网络双设备语音尚未完成验收。

## 可以做什么

- **自在对话**：用轻松的提示打开话题，轮流分享与倾听。
- **一起共读**：围绕同一段文字交流，留下一个收获或待研究的问题。
- **对词排练**：分配角色、对词、讨论表达，再记录需要调整的地方。
- 邀请链接或房间码加入，双人房间最多两位成员。
- 双方准备后开始；支持暂停、恢复、推进环节和确认交接主持权。
- 服务器保存房间状态，刷新后恢复当前进度。
- 共同记录手动保存；单人房间显示个人练习记录。
- WebRTC 双人语音，可接入 TURN 中继或使用 LiveKit。

应用不会自动录制音频。房间有效期为创建后 24 小时；过期后不能继续进入。数据库使用本地持久化，房间过期不等于立即从数据库物理删除。

## 快速运行

需要 **Node.js 24** 和 npm。进入源码目录后：

```bash
cp .env.example .env
npm ci
npm run build
npm start
```

默认在本机 `http://127.0.0.1:3000/` 打开，数据目录为 `./data`。

localhost 适合开发。让手机或另一台设备使用麦克风时，请通过 HTTPS 打开应用。面向中国大陆使用时，请使用自己的已备案域名。

完整服务器部署示例见 [腾讯云部署](./DEPLOY_TENCENT.md)。

## 运行结构

| 位置 | 用途 |
| --- | --- |
| `standalone/client/` | 构建后的网页与静态资源 |
| `standalone/server/index.mjs` | Node.js 服务入口 |
| `components/`、`hooks/`、`lib/` | 网页组件、房间操作、语音与共享规则 |
| `drizzle/` | 数据库初始化与升级 SQL |
| `deploy/` | systemd、Caddy 和 coturn 配置示例 |
| `data/` | 默认本地数据目录，不应提交到源码仓库 |

服务保存权威房间状态，网页定时读取快照。语音连接与房间同步分别处理：声音可以发生网络波动，房间也需要保持自己的状态来源。

GitHub 用于分发源代码。自行部署后，用户打开网页与通话不依赖 GitHub 在线服务。

## 环境变量

复制 `.env.example` 后按需要填写。环境变量由服务进程读取，不应放入网页源码。

| 变量 | 默认值或示例 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 服务端口 |
| `HOST` | `127.0.0.1` | 监听地址，适合由本机反向代理提供 HTTPS |
| `DATA_DIR` | `./data` | 持久数据目录 |
| `APP_BASE_PATH` | 空 | 默认根路径；子路径部署可设置为 `/tongzai` |
| `STUN_URLS` | 空 | 可选 STUN 地址，多个地址用逗号分隔 |
| `TURN_URL` | 空 | TURN 地址，多个地址用逗号分隔 |
| `TURN_SHARED_SECRET` | 空 | 与 coturn 一致的共享密钥，用来签发临时凭证 |
| `TURN_TTL_SECONDS` | `7200` | 临时 TURN 凭证的请求有效期，单位为秒 |
| `ICE_TRANSPORT_POLICY` | `all` | 通常使用 `all`；排查中继时可使用 `relay` |
| `LIVEKIT_URL` | 空 | 可选 LiveKit 服务的 `wss://` 地址 |
| `LIVEKIT_API_KEY` | 空 | 可选 LiveKit API key |
| `LIVEKIT_API_SECRET` | 空 | 可选 LiveKit 服务端签名密钥 |

`APP_BASE_PATH` 在构建时与运行时必须一致。例如要使用 `https://example.com/tongzai/`，在 `.env` 中设置：

```dotenv
APP_BASE_PATH=/tongzai
```

然后重新执行 `npm run build`，再启动服务。不要只在启动后修改路径：网页资源、API、邀请链接和页面跳转必须使用同一前缀。

## 语音接入

### WebRTC 直连

无需 LiveKit 账号即可使用浏览器的 WebRTC 直连能力。可配置自己选用的 STUN 服务，帮助浏览器发现网络地址。

直连能否成功取决于参与者所在的网络。应用显示的“语音已连接”以实际连接事件为依据；STUN 或 TURN 配置存在，不表示已经完成跨网络通话验证。

### TURN 中继

当直连不通时，中继可以提供另一条音频路径。配置 `TURN_URL` 和 `TURN_SHARED_SECRET`，并保证共享密钥与 coturn 配置一致。

应用只向已鉴权的当前房间成员签发临时 TURN 凭证。公开的 `GET /api/voice-config` 不返回密码；房间成员通过 `GET /api/rooms/:id/voice-config` 获取自己的语音配置。

`ICE_TRANSPORT_POLICY=all` 允许浏览器选择可用路径。`relay` 只尝试中继，适合确认中继是否实际可用；设置前应先完成 TURN 部署。

### LiveKit

同时设置 `LIVEKIT_URL`、`LIVEKIT_API_KEY`、`LIVEKIT_API_SECRET` 后，可使用 LiveKit 音频服务。房间凭证由后端为已加入的成员签发，API secret 不会下发给网页。

本项目不附带 LiveKit 账号、额度或服务凭证。

## 使用方法

1. 选择模板、时长，填写临时昵称。
2. 创建好友房间，把邀请链接发给伙伴。
3. 对方加入后，双方点击准备，由主持者开始。
4. 需要通话时，各自点击开启语音并允许麦克风。
5. 按提示交流；任何一方都可以暂停或关闭自己的语音。
6. 手动保存共同记录，再结束房间。

成员身份保存在当前浏览器标签页的会话存储中，刷新可以恢复。关闭标签页或清理浏览器存储后，这份临时身份可能丢失。

## 当前范围

这是面向个人低流量的单进程应用。当前版本提供邀请房间和单人练习；随机匹配、自动录音、付费、社区与实时 AI 主持不在首版范围内。

国内网络测试需要同时检查网页、API、静态资源与音频。浏览器能打开首页，不代表两台设备已经可以互相听见。部署后应使用目标用户实际使用的设备与网络完成一次双人体验。

## 开发检查

```bash
npm run typecheck
npm run build
npm test
```

当前包含 9 个通过的测试，覆盖状态机、真实 HTTP 请求、并发加入、SQLite 事务和重启持久化，以及短期 TURN 凭证。音频是否双向可听需要真实设备验证。

## 许可证

MIT，Copyright (c) 2026 ConanXin。完整文本见 `LICENSE`。
