# Vercel 网页与 Vultr 后台的手动部署

由 GitHub Actions 管理的生产项目请使用 [自动发布与恢复](production-release.md)。以下手动步骤适用于独立实例。

可选的公开媒体存储见 [R2 公开媒体](r2-media.md)。

| 入口 | 示例 | 用途 |
| --- | --- | --- |
| Vercel 网页 | `https://watch.example.org` | 房主登录、房间和邀请链接 |
| Vultr 后台 | `https://api-watch.example.org` | 房间 API、导入、播放同步和受保护的媒体 |

替换两个示例域名并使用同一可注册域名下的两个 HTTPS 子域。浏览器把两者视为不同 Origin，但仍是同站。房主和访客的 Cookie 由后台签发，仅发往后台主机，保留 `Secure`、`HttpOnly` 和 `SameSite=Strict`。后台只允许正式网页的精确 Origin 发起带凭据的跨源请求。Vercel 的预览域与 `.vercel.app` 地址无法使用生产后台的会话，请从绑定的正式网页域打开应用及分享链接。

## 首次设置 Vultr

1. 在可访问 B 站公开 API 和媒体 CDN 的 Linux 主机上安装 Docker Engine 与 Compose v2。部署账号需要读取源码和服务器配置，并有权运行 Docker Compose。把后台域的 DNS 解析到 Vultr，放行 TCP 80 和 443。确认浏览器可直连该地址。
2. 在主机上检出要发布的提交。把配置写入仅部署账号可读、位于仓库之外的文件。已有部署保留 `HOST_PASSWORD`、Compose 项目名和原有卷配置，将 `PUBLIC_ORIGIN` 改为后台域，并增加 `WEB_ORIGIN`。以下命令供首次设置，在配置文件尚不存在时运行。

   ```sh
   mkdir -p "$HOME/.config/bili-watch-party"
   (
     umask 077
     printf 'PUBLIC_ORIGIN=%s\nWEB_ORIGIN=%s\nHOST_PASSWORD=%s\n' \
       'https://api-watch.example.org' 'https://watch.example.org' "$(openssl rand -hex 32)" \
       > "$HOME/.config/bili-watch-party/compose.env"
   )
   ```

3. 在仓库根目录验证配置并启动。迁移或升级时，用相同的项目名和卷名启动，保留应用数据和 Caddy 证书卷。Caddy 会为新后台域申请证书。房主在服务重启后需要重新登录。

   ```sh
   docker compose --env-file "$HOME/.config/bili-watch-party/compose.env" config --quiet
   docker compose --env-file "$HOME/.config/bili-watch-party/compose.env" up -d --build --force-recreate
   curl -sS -o /dev/null -w '%{http_code}\n' https://api-watch.example.org/api/session
   ```

   未登录的 HTTPS 会话探测预期返回 `401`。运行 `docker compose ps` 时使用同一份 `--env-file` 和项目名。日志留在服务器或私有验收目录。运维和卷配置参见 [Linux 单机 HTTPS 部署](../README.md#linux-单机-https-部署)。

## 手动发布 Vercel 网页

1. 准备一个手动发布的 Vercel 项目，在项目中绑定并验证正式网页域 `watch.example.org`。在 Production 环境设置公开变量 `API_ORIGIN=https://api-watch.example.org`，源地址末尾不带斜杠。房主密码和运行数据只保留在 Vultr。
2. 在本机使用 Node.js 24 或更高版本，从同一提交的干净检出目录运行以下命令。仓库的 `vercel.json` 指定静态构建及房间、邀请的深链接重写。`build:web` 将浏览器所需的静态文件和公开的后台地址写入 `dist/`。预构建发布上传静态产物。

   ```sh
   vercel link
   vercel pull --yes --environment=production
   vercel build --prod
   vercel deploy --prebuilt --prod
   ```

   参考 [Vercel 本地构建](https://vercel.com/docs/cli/build) 和 [预构建发布](https://vercel.com/docs/cli/deploy#prebuilt)。
3. 使用正式网页域验收首页登录、房间刷新、邀请审批和两端播放与跳转。在专用测试实例中，向测试进程提供该实例的 `HOST_PASSWORD`，并运行以下命令。浏览器测试会创建和结束测试房间。

   ```sh
   BROWSER_ORIGIN=https://watch.example.org \
   BROWSER_API_ORIGIN=https://api-watch.example.org \
     npm run test:browser
   ```

## 本机隔离验收

可使用两个回环 HTTPS 端口重现同站跨源访问。在一套独立测试环境中，把后台的 `PUBLIC_ORIGIN` 设成 `https://localhost:8443`，把 `WEB_ORIGIN` 设成 `https://localhost:8444`。使用 Compose 时同时设置 `WATCH_BIND_IP=127.0.0.1`、`WATCH_HTTPS_PORT=8443`、独立的 Compose 项目名及数据卷和 TLS 卷。也可以在 Node.js 24 下启动应用，通过 Caddy 将 8443 转发到应用的回环监听端口。准备 FFmpeg、FFprobe 和浏览器后，构建网页产物。

```sh
npm ci
npx playwright install chromium webkit
API_ORIGIN=https://localhost:8443 npm run build:web
export WATCH_WEB_DIST="$PWD/dist"
```

在独立的 Caddy 配置中添加下列静态网页站点。可将 Caddy 的数据目录和配置目录指向私有临时目录。用 Caddy 本地 CA 单独验证两个站点的 TLS，浏览器测试用 `BROWSER_LOCAL_TLS=1` 接受本地测试证书。

```caddyfile
{
    admin off
    skip_install_trust
    auto_https disable_redirects
}

https://localhost:8444 {
    bind 127.0.0.1
    tls internal
    header Permissions-Policy "microphone=()"
    header Referrer-Policy "no-referrer"
    header Content-Security-Policy "frame-ancestors 'none'"
    @deep path_regexp ^/(rooms|invite)/[a-f0-9-]+$
    rewrite @deep /index.html
    root * {$WATCH_WEB_DIST}
    file_server
}
```

向测试进程提供测试实例的 `HOST_PASSWORD`。可选的 `BROWSER_DATA_DIR` 指向本机可读取的后台数据目录，用于验证成品音画轨道和完整解码。

```sh
BROWSER_ORIGIN=https://localhost:8444 BROWSER_API_ORIGIN=https://localhost:8443 \
  BROWSER_LOCAL_TLS=1 npm run test:browser
```

### 隔离验收结果

在 Caddy 提供的两个回环 HTTPS Origin 上，用 Chromium 的 Pixel 7 和 WebKit 的 iPhone 13 模拟环境验证了公开投稿 `BV1TDyazeEuY` 的实际导入。两个浏览器均通过网页域登录、刷新房间和邀请页面、批准访客、同步播放与跳转。已授权房主及访客的 `HEAD` 返回 `200`，浏览器跨源请求视频片段返回 `206`。未获批准的会话直接请求后台媒体返回 `401`，陌生 Origin 的 API 请求返回 `403`。成品为 H.264 480p 与 AAC，时长 818.79 秒，完整解码通过。

本地 Vercel 预构建生成了静态网页和两类深链接重写，单机和拆分的 Compose 配置均通过检查。生产环境待验证实际 Vercel 项目发布及深链接重写、Vultr 主机上的 Compose 启动与持久卷复用、两个子域的 DNS 和公开可信证书，以及通过正式域名的房间与媒体验收。隔离测试使用回环端口和本地 CA。
