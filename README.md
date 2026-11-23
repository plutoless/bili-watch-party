# B 站一起看

房主登录后，可粘贴 B 站普通投稿链接创建私密房间。后台下载对应分 P 的公开音画轨道，合并为 MP4。房间显示已识别的影片、导入阶段与失败原因。就绪后用原生播放器播放和拖动进度条。

## 本机运行

准备 Node.js 24、FFmpeg 和 FFprobe。启动服务器的机器需要能访问 B 站公开 API 和媒体 CDN。

```sh
npm ci
# zsh，输入密码时不回显
read -rs 'HOST_PASSWORD?房主密码（至少 16 字符）: '
export HOST_PASSWORD
npm start
```

打开 `http://127.0.0.1:3000`。使用独立的高强度房主密码。服务只监听本机回环地址。如需通过已有 HTTPS 反向代理访问，将 `PUBLIC_ORIGIN` 设为浏览器使用的 HTTPS 源地址，例如 `https://watch.example.org`，末尾省略斜杠。代理需转发 Cookie、Origin 和 Range 请求头，并保留 206 响应。房主 Cookie 在 HTTPS 模式下带 `Secure`，有效期 12 小时。进程重启后需重新登录，房间和成品保留。

| 环境变量 | 用途 |
| --- | --- |
| `HOST_PASSWORD` | 房主密码，必填 |
| `PORT` | 本机端口，默认 3000 |
| `DATA_DIR` | 运行数据目录，默认 `~/.bili-watch-party` |
| `PUBLIC_ORIGIN` | 反向代理的 HTTPS 源地址，本机运行时留空 |
| `FFMPEG_PATH` / `FFPROBE_PATH` | 可选，指定程序路径，默认从 PATH 读取 |

请把运行数据、配置和日志保存在仓库之外。一个数据目录由一个服务进程使用。导入按顺序执行，下载和合并临时文件会在导入结束后删除，重启时也会清理遗留临时文件。成品和房间数据保留在数据目录，若需清理，请先停服务，再清理该目录。

## 支持的片源与恢复

- 支持 `https://www.bilibili.com/video/BV1TDyazeEuY` 形式的 BV 投稿地址。用 `?p=2` 等参数指定分 P，省略时导入 P1。同一投稿和分 P 的再次提交打开原房间。
- 房间显示等待、下载、准备、就绪或失败。网络异常、服务重启导致中断等可恢复错误可在原房间重试。重试请求针对页面上显示的失败尝试，重复发送同一请求只会开始一次新尝试。
- 此版本使用可公开获取的 H.264/AAC 分离轨道（至多 480p，每条轨道最大 512 MiB）。支持范围为 BV 投稿及其分 P。短链、AV 链接、番剧地址和需要会员或登录权限的片源属于后续兼容范围。
- 房主会话保护房间数据和 MP4（含 HEAD 与单个字节范围）。此版本提供单房主入口。访客邀请、审批和双端同步由后续工单实现。

## 验收

```sh
npm run check
npm test
npx playwright install chromium webkit
npm run test:browser
SIMULATE_FIRST_FAILURE=1 npm run test:browser
```

HTTP 测试用合成样本覆盖未登录访问、链接校验、并发重复提交、首次网络失败、重复重试、片源权限、试看和字节范围。浏览器测试从网页提交公开投稿 `BV1TDyazeEuY`，在 Chromium 的 Pixel 7 和 WebKit 的 iPhone 13 模拟环境播放，跳转至第 600 秒，并检查未登录会话无法获取视频。测试用 FFprobe 确认轨道，再用 FFmpeg 完整解码。打开 `SIMULATE_FIRST_FAILURE` 可注入首次导入断线，然后从同一房间点击重试并实际导入。测试所用的影片与运行数据保存在系统临时目录，结束即清理。
