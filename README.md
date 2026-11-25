# B 站一起看

房主登录后粘贴 B 站普通投稿链接，一次提交即可进入房间。后台导入可公开播放的对应分 P 并合并为 MP4，同时房主可以分享或复制自动生成的私密邀请。剪贴板不可用时，页面会选中链接供手动复制。访客在手机浏览器打开链接就会发出加入申请，无需安装或注册。房主可直接批准单份申请，有多份申请时可用申请编号核对。房主批准后，访客占用唯一席位。房主也可以从同一浏览器的首页继续最近打开且仍然有效的房间。

视频就绪后，两端各点一次「准备好了」。页面显示双方的就绪情况，房主可播放、暂停或拖动进度。访客的播放器自动跟随。跳转时，两端会暂停并等待在目标位置就绪，随后按房主原先的播放状态继续或保持暂停。如果浏览器阻止起播，页面会提示再次点按，房间会等待。

两端都可以进入网页全屏，查看播放时间、进度和缓冲状态。全屏播放时轻点画面会显示控制栏，退出入口会一直显示。影片结束后，房主可以重播或结束房间。

任一端缓冲、掉线或离开观影页面时，房间会暂停。恢复连接、在原标签页刷新或回到前台后，播放器会回到共享位置，双方就绪后才继续。房主在等待期间仍可暂停，即使房主当时掉线，暂停也会在恢复连接后同步。若刷新后的浏览器要求新的手势，原席位会保留，页面会提示再次点按。

邀请有效期为 30 分钟。重复提交、刷新和导入重试保留原房间及其邀请状态。房主可以在「管理房间」里更换或撤销邀请。更换或撤销邀请会使旧链接和未批准申请失效，已批准的访客可继续观看。结束房间会立即撤销邀请、访客会话及本地媒体访问，包括已开始传输的响应，正在运行的导入也会取消。服务保留最小的结束记录和本地成品到清理期限，默认 24 小时。服务启动时和运行中每分钟检查一次清理期限。已分享的 R2 公开媒体链接仍可访问，直到对象按媒体桶的生命周期规则删除。

## 本机运行

准备 Node.js 24、FFmpeg 和 FFprobe。启动服务器的机器需要能访问 B 站公开 API 和媒体 CDN。

```sh
npm ci
# zsh，输入密码时不回显
read -rs 'HOST_PASSWORD?房主密码（至少 16 字符）: '
export HOST_PASSWORD
npm start
```

打开 `http://127.0.0.1:3000`。服务监听本机回环地址。若使用已有 HTTPS 反向代理，将 `PUBLIC_ORIGIN` 设为浏览器使用的 HTTPS 源地址，末尾省略斜杠。代理需在回环地址转发 Cookie、Origin 和 Range，保留 206 响应，并用真实对端 IP 覆盖 `X-Forwarded-For`，供应用按客户端隔离登录限速。

| 环境变量 | 用途 |
| --- | --- |
| `HOST_PASSWORD` | 房主密码，至少 16 字符，必填 |
| `PORT` | 本机端口，默认 3000 |
| `DATA_DIR` | 运行数据目录，默认 `~/.bili-watch-party` |
| `PUBLIC_ORIGIN` | 浏览器访问的 HTTPS 源地址，本机 HTTP 运行时留空 |
| `WEB_ORIGIN` | 拆分部署时允许的正式网页 HTTPS 源地址，单机运行时留空 |
| `ENDED_ROOM_RETENTION_HOURS` | 已结束房间的成品与结束记录保留小时数，默认 24 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 可选，指定程序路径，默认从 PATH 读取 |

HTTPS 模式下房主和访客 Cookie 都带 `Secure`、`HttpOnly` 和 `SameSite=Strict`。房主会话有效期为 12 小时，服务重启后需重新登录。已批准访客可使用同一浏览器会话刷新和访问；房间结束时该会话失效。运行数据、配置和日志保存在仓库之外。一个数据目录由一个服务进程使用。导入按顺序执行，下载和合并的临时文件会在导入结束后删除，重启时也会清理遗留文件。

## Linux 单机 HTTPS 部署

1. 在一台可访问 B 站公开 API 和媒体 CDN 的 Linux 主机上准备 Docker Engine 和 Docker Compose v2。将部署域名解析到主机，放行 TCP 80 和 443，并确认这两个端口可用。发布 AAAA 记录前确认对应 IPv6 地址也能访问这两个端口。
2. 在服务器上获取项目源码，以服务器实际域名替换示例。把配置写进仓库外的文件，并保持只对部署用户可读。首次生成的随机密码供房主登录，请按私密凭证保管。

   ```sh
   mkdir -p "$HOME/.config/bili-watch-party"
   (
     umask 077
     printf 'PUBLIC_ORIGIN=%s\nHOST_PASSWORD=%s\n' \
       'https://watch.example.org' "$(openssl rand -hex 32)" \
       > "$HOME/.config/bili-watch-party/compose.env"
   )
   ```

3. 可在该配置中设置 `WATCH_DATA_VOLUME`（默认 `bili-watch-party-rooms`）、`WATCH_TLS_VOLUME`（默认 `bili-watch-party-tls`）和 `ENDED_ROOM_RETENTION_HOURS`。在仓库根目录启动：

   ```sh
   docker compose --env-file "$HOME/.config/bili-watch-party/compose.env" config --quiet
   docker compose --env-file "$HOME/.config/bili-watch-party/compose.env" up -d --build
   ```

4. 从配置的 HTTPS 域名打开房主入口。Caddy 为域名申请及续期证书，并在同一个容器网络命名空间内通过回环地址访问应用。对主机只发布代理的 TCP 80 和 443。应用数据卷保存 SQLite、暂存文件和成品，Caddy 数据卷保存证书及其私钥。配置和这些卷仅供服务器管理员访问。
5. 升级应用时使用 `up -d --build --force-recreate` 一起重建两个容器。迁移时先停止服务，再将应用数据卷复制至新主机的对应卷，保留卷内文件的权限和属主。复用域名时也可迁移 Caddy 数据卷。验证新主机的 DNS、HTTPS 和导入后再切换访问。日常停止用 `stop` 保留卷。

## Vercel 网页与 Vultr 后台

分别托管时，房主和访客使用同一个网页域，网页 API 访问同站的后台 HTTPS 域。默认媒体保存在 Vultr 数据卷中，按房间会话授权。也可启用 R2 公开媒体，浏览器从独立的媒体域直读成品。参见 [自动发布与恢复](docs/production-release.md)、[手动拆分部署](docs/split-deployment.md) 和 [R2 公开媒体](docs/r2-media.md)。

## 支持的片源与恢复

- 支持 `https://www.bilibili.com/video/BV1TDyazeEuY` 形式的 BV 投稿地址。用 `?p=2` 等参数指定分 P，省略时导入 P1。同一投稿和分 P 的再次提交打开原有活动房间。结束后可以为同一片源创建新房间。
- 导入页显示等待、下载、准备、就绪或失败。网络异常、服务重启导致中断等可恢复错误可在原房间重试。重试请求针对页面上显示的失败尝试，同一请求只会启动一次新尝试。
- 使用可公开获取的 H.264/AAC 分离轨道（至多 480p，每条轨道最大 512 MiB）。支持范围为 BV 投稿及其分 P。

## 验收

```sh
npm run check
npm test
npx playwright install chromium webkit
SYNTHETIC_VIDEO=1 npm run test:browser
BROWSER_SYNTHETIC_SPLIT=1 SYNTHETIC_VIDEO=1 npm run test:browser
npm run test:browser
SIMULATE_FIRST_FAILURE=1 npm run test:browser
```

HTTP 测试用合成样本覆盖导入和重试、邀请轮换和过期、并发审批、媒体权限、播放命令版本与就绪门控，以及结束房间后的清理。浏览器测试使用 Chromium 的 Pixel 7 和 WebKit 的 iPhone 13 模拟环境，覆盖同类和混合配对。每次都用独立的房主、访客和第三方会话验证邀请与准入、首页回房、共享播放、就绪与手势反馈、暂停、跳转、纠偏和房间结束。

拆分夹具在不同的回环 HTTPS 源分别运行网页和 API。浏览器验收覆盖两种视口方向、全屏进出、单次点按唤出控制栏、访客手势与快捷键、显式重播以及结束后的媒体拒绝。

默认浏览器测试从网页提交公开投稿 `BV1TDyazeEuY`。用 `SIMULATE_FIRST_FAILURE=1` 注入首次导入断线，再从原房间重试。本地也可以用 `SYNTHETIC_VIDEO=1` 生成临时 H.264/AAC 视频并控制导入时机和邀请过期，两项开关可以同时使用。两种模式都通过服务端提供的视频，在浏览器里读取真实播放器位置。自管测试服务时还用 FFprobe 检查轨道并用 FFmpeg 完整解码一份成品。

同步采样在两端实际进度均通过 0.25 秒后再留出 1.5 秒，随后每 100 毫秒比较一次，共 10 秒、100 个配对采样点。测试用八轮往返中耗时最低的一轮，将各页面的单调时钟对齐到测试进程，再对各播放器读取的 `currentTime` 做线性插值。采样期间无需房主操作，自动纠偏时的采样点也照常计入，要求至少 95% 的绝对进度差严格小于 0.5 秒。访客的播放状态请求加入 80 毫秒单向延迟。测试单独验收手势失败和重试、延迟跳转确认、暂停时跳转、越权命令与纠偏。

恢复验收在独立会话中暂扣实际 MP4 响应以验证缓冲，用浏览器离线模式并中止播放状态请求来触发掉线。覆盖连续跳转时旧就绪迟到、缓冲时暂停、房主离线时请求暂停、访客刷新和前后台切换。输出记录恢复后共同前进 0.25 秒的耗时和两端进度差，并在刷新恢复后再做一次稳定采样。若浏览器模拟无法产生原生标签页可见性变化，测试会注入 `visibilitychange` 并在输出中注明。

在专用部署上，把 `BROWSER_ORIGIN` 设为部署后的 HTTPS 源地址，并向测试进程提供该环境的 `HOST_PASSWORD`，运行 `npm run test:browser`。测试会提交真实导入并结束相应房间。 拆分部署时设置 `BROWSER_API_ORIGIN` 指向后台。测试按房间返回的媒体来源断言访问方式。受保护模式验证已批准的会话从后台取得 `Range/206`，其他会话被拒绝。R2 模式可设置 `BROWSER_MEDIA_ORIGIN` 明确要求指定的 HTTPS 媒体域，验证播放器直接使用公开地址、匿名片段返回 `206`，房间与播放控制仍需后台授权。生产生命周期、受控删除和重导入另行验收。独立的 Compose 回环实例可设置 `WATCH_BIND_IP=127.0.0.1`、`WATCH_HTTPS_PORT=8443` 和 `PUBLIC_ORIGIN=https://localhost:8443`。如果该实例使用本地 CA，可为测试进程设 `BROWSER_LOCAL_TLS=1`，并用该 CA 单独校验 TLS。受保护模式可设置 `BROWSER_DATA_DIR` 指向部署的本地运行数据目录，供 FFprobe 和 FFmpeg 检查成品。请在仓库之外保存临时运行数据和任何测试日志。
