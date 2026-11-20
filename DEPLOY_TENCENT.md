# 在腾讯云运行同在

此方案适合一台已有 Linux 云服务器：一个 Node.js 进程，本地数据库，复用已有 HTTPS 域名。以下域名、IP 占位和共享密钥都需要替换成自己的配置。

## 1. 准备源码与环境

安装 Node.js 24 与 npm，将独立版源码放到 `/opt/tongzai`。面向中国大陆使用时，请使用自己的已备案域名。

```bash
cd /opt/tongzai
cp .env.example .env
```

编辑 `.env`：

```dotenv
PORT=3000
HOST=127.0.0.1
DATA_DIR=./data
APP_BASE_PATH=/tongzai
TURN_TTL_SECONDS=7200
ICE_TRANSPORT_POLICY=all
```

这里选择 `/tongzai/` 子路径，保留域名上的其他应用。`APP_BASE_PATH` 的构建值与运行值必须相同。

```bash
npm ci
npm run build
npm start
```

本机确认 `http://127.0.0.1:3000/tongzai/` 能返回网页后，结束前台进程，交给下面的 systemd 服务运行。

## 2. 通过现有域名提供 HTTPS

将 `deploy/Caddyfile.example` 中的路由加入已有 Caddy 域名站点块：

```caddy
example.com {
    redir /tongzai /tongzai/ 308

    handle /tongzai/* {
        reverse_proxy 127.0.0.1:3000
    }

    # 该域名的其他路由继续放在此站点块中。
}
```

这里使用 `handle`，让 `/tongzai` 前缀原样送到应用。不要换成会剥离前缀的 `handle_path`。

保存后重新加载 Caddy：

```bash
sudo systemctl reload caddy
```

现在使用自己的 `https://example.com/tongzai/` 地址访问。远程设备开启麦克风需要 HTTPS。

## 3. 用 systemd 运行一个进程

示例服务以项目专用运行用户 `tongzai` 启动。如果尚未创建：

```bash
sudo useradd --system --home /opt/tongzai --shell /usr/sbin/nologin tongzai
sudo mkdir -p /opt/tongzai/data
sudo chown -R tongzai:tongzai /opt/tongzai
sudo cp deploy/tongzai.service.example /etc/systemd/system/tongzai.service
sudo systemctl daemon-reload
sudo systemctl enable --now tongzai
```

`deploy/tongzai.service.example` 默认使用 `/usr/bin/node`。如果 Node 安装在其他位置，使用 `command -v node` 查到的 Node.js 24 路径修改 `ExecStart`。

查看运行状态与近期日志：

```bash
sudo systemctl status tongzai --no-pager
sudo journalctl -u tongzai -n 60 --no-pager
```

数据库与房间记录保存在 `DATA_DIR`。修改配置或更新代码后，重新构建并执行 `sudo systemctl restart tongzai`。

## 4. 需要中继时安装 coturn

Ubuntu/Debian 示例：

```bash
sudo apt-get update
sudo apt-get install -y coturn
sudo cp deploy/turnserver.conf.example /etc/turnserver.conf
```

编辑 `/etc/turnserver.conf`：

- 将 `PUBLIC_IPV4` 替换成云服务器公网 IPv4。
- 将 `PRIVATE_IPV4` 替换成服务器网卡实际使用的内网 IPv4。
- 将 `static-auth-secret` 替换成自己的共享密钥。
- 设置自己使用的 `realm`，例如 `voice.example.com`。

腾讯云使用公网到私网映射时，`external-ip=PUBLIC_IPV4/PRIVATE_IPV4` 与 `relay-ip=PRIVATE_IPV4` 配合使用。若机器直接持有公网地址，则按该机器实际网络填写 `relay-ip`，并将 `external-ip` 设为其公网地址。

在云安全组和系统防火墙中放行本例需要的端口：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| `3478` | UDP、TCP | TURN/STUN 连接入口 |
| `49160–49200` | UDP | 本例配置的媒体中继端口范围 |
| `5349` | TCP | 仅配置有效证书并启用 TURN/TLS 后使用 |

示例配置关闭了 TLS/DTLS，不使用 `5349`。HTTPS 网页入口与 TURN 入口分别配置；Caddy 的普通 HTTP 反向代理不能代替 TURN 的 UDP 媒体端口。

在应用 `.env` 中填写相同共享密钥：

```dotenv
STUN_URLS=stun:voice.example.com:3478
TURN_URL=turn:voice.example.com:3478?transport=udp,turn:voice.example.com:3478?transport=tcp
TURN_SHARED_SECRET=replace-with-your-own-shared-secret
TURN_TTL_SECONDS=7200
ICE_TRANSPORT_POLICY=all
```

启动中继并重新启动应用：

```bash
sudo systemctl enable --now coturn
sudo systemctl restart tongzai
```

这一步只表示服务已配置。用两台设备实际加入语音、确认双方都能听到声音，才完成通话验证。需要专门确认中继时，可临时设置 `ICE_TRANSPORT_POLICY=relay` 后重新启动应用；验证完成后按需要使用 `all`。

## 5. 完成一次实际使用

打开 HTTPS 首页，创建好友房间，将链接交给另一台设备。完成加入、双方准备、开启语音、共享暂停、保存记录和结束。

建议至少用一次“Wi-Fi 与手机移动网络”的组合。若国内访问出现问题，分别确认页面、API、资源文件和音频链路。源码托管平台不参与应用运行，不需要用户在通话时连接 GitHub。

应用不会自动录音。房间创建后 24 小时过期，数据文件保存在本机配置的目录中。

## 6. 排查语音连接

加入好友房间后，展开「连接检测」并点击「检测当前网络」。这个检查不请求麦克风权限，也不需要第二位成员。获取配置和地址收集各最多等待 8 秒，可主动取消。

若中继显示「未确认可用」，检查部署配置与入站规则，并尝试从目标设备的实际网络再次检测。复制的摘要只有状态、候选数量和错误码，适合用于定位问题；不会包含 IP、SDP 或临时凭证。

取得 relay 候选证明完成了本次中继地址分配，仍需两台设备开启语音确认双向声音。连接成功后的直连/中继标记读取实际选中的候选对。技术依据：[W3C WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) 与 [MDN ICE 错误码](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnectionIceErrorEvent/errorCode)。
