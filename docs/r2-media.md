# R2 公开媒体

开启后，后台继续用 FFmpeg 复制 B 站的 H.264 画轨和 AAC 音轨，将成品封装成快速起播的 MP4。浏览器从媒体域直接请求视频片段，房间、邀请审批和同步控制仍经后台校验会话。持有公开媒体地址的人可以在对象删除前播放，即使房间已结束。房间记录、凭据、源轨道和临时文件留在后台。

## Cloudflare 配置

1. 首次配置时创建默认管辖区的应用专用桶，仅用于成品 MP4。已有符合此用途的桶可继续使用。为 Vultr 创建范围仅限该桶的 **Object Read & Write** S3 凭据。将它保存到服务器私有配置文件。网页构建、Vercel 和 GitHub Actions 只接收公开的媒体 Origin。 [R2 凭据](https://developers.cloudflare.com/r2/api/tokens/)
2. 在该桶的 **Settings → Custom Domains** 连接正式媒体域，例如 `media-watch.example.org`。等待域名和 TLS 生效。正式环境关闭 `r2.dev` 开发入口。 [R2 公开桶](https://developers.cloudflare.com/r2/buckets/public-buckets/)
3. 在 Cloudflare **Cache Rules** 中为表达式 `(http.host eq "media-watch.example.org")` 设置 **Bypass cache**。检查同域的其他规则不会重新启用缓存。成品同时携带 `Cache-Control: public, no-store`。如曾启用共享缓存，清理旧条目。 [Cloudflare 缓存规则](https://developers.cloudflare.com/cache/how-to/cache-rules/create-dashboard/)
4. 设置如下的桶 CORS 策略，将示例 Origin 换成正式网页地址。若由后台提供单机网页，则填 `PUBLIC_ORIGIN`。播放器跨源匿名请求媒体。 [R2 CORS](https://developers.cloudflare.com/r2/buckets/cors/)

   ```json
   [
     {
       "AllowedOrigins": ["https://watch.example.org"],
       "AllowedMethods": ["GET", "HEAD"],
       "AllowedHeaders": ["Range"],
       "ExposeHeaders": ["Accept-Ranges", "Content-Range"]
     }
   ]
   ```

5. 首次配置时在桶的 **Settings → Object Lifecycle Rules** 启用全桶规则，前缀留空，按对象年龄在 **3 天后删除**。通过获准的 Dashboard 只读访问，或用另行授权的运维凭据读取 S3 的 `GetBucketLifecycleConfiguration`，核对已有规则与下例等效。对象年龄从上传完成算起。删除异步执行，Cloudflare 说明对象通常在其到期时间后 24 小时内移除。以对象实际删除作为失效依据。 [R2 生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

   ```json
   {
     "Rules": [
       {
         "ID": "expire-finished-media",
         "Status": "Enabled",
         "Filter": { "Prefix": "" },
         "Expiration": { "Days": 3 }
       }
     ]
   }
   ```

## 应用配置

先把 `MEDIA_ORIGIN=https://media-watch.example.org` 加入自动发布的 `production` 环境 **Variable**，或加入手动 Vercel 构建的 Production 环境变量。发布能加载该媒体域的网页后，再启用 Vultr 的 R2 导入。此顺序使后台先行升级期间，正在使用旧网页的人可以继续播放本地媒体。

在 Vultr 上已有的私有 `compose.env` 设置以下五项，并沿用现有的房间数据卷和 HTTPS Origin。服务器配置文件保持在仓库之外，权限为 `0600`。

| 配置 | 值 |
| --- | --- |
| `MEDIA_ORIGIN` | 正式媒体 HTTPS Origin，无结尾斜杠，与网页和后台 Origin 不同 |
| `R2_ACCOUNT_ID` | 建桶账号 ID |
| `R2_BUCKET` | 专用桶名称 |
| `R2_ACCESS_KEY_ID` | 仅部署在 Vultr 的桶级 S3 Access Key ID |
| `R2_SECRET_ACCESS_KEY` | 仅部署在 Vultr 的桶级 S3 Secret Access Key |

五项均留空时，新导入继续使用原来的受保护本地媒体。已有本地媒体仍从后台读取。启用 R2 后，保留同一个专用桶及其媒体域配置，直到相应房间结束。上传重试保留待发布 MP4，成功后清理本地成品。结束失败的房间后，待发布 MP4 随服务器现有的房间文件保留期清理。当前在线房间发现 R2 对象已删除后，房主可以在原房间选择「重新导入」。重新导入产生新地址，原地址继续失效。

## 验收

隔离测试发现 WebKit 对公开直链频繁变速时会卡顿。公开媒体用正常速度播放，较大偏差仍使用原有的跳转纠正。受保护本地媒体沿用原有变速纠偏。

本机隔离模式使用三个 HTTPS Origin，网页走同一套静态构建，后台使用真实导入与会话接口，媒体用回环对象存储夹具。合成模式生成独立音画轨道并经过实际 FFmpeg 轨道复制和 FFprobe 验证。

```sh
npm ci
npx playwright install chromium webkit
npm test
SYNTHETIC_VIDEO=1 BROWSER_R2_FIXTURE=1 npm run test:browser
BROWSER_R2_FIXTURE=1 npm run test:browser
SYNTHETIC_VIDEO=1 BROWSER_SYNTHETIC_SPLIT=1 npm run test:browser
```

第二个浏览器命令使用公开 B 站样本，需要本机能够访问 B 站 API 及媒体 CDN。浏览器测试会在用户界面提交链接、验证直接播放的 `Range` 和 `206`，并用夹具删除对象验证重导入。数据与媒体生成在私有临时目录，退出时清理。

实际环境验收可复用获准的现有 Vercel 项目、Vultr 主机和本应用专用的成品媒体桶。通过正常发布流程确认网页和后台对应获准验收的版本。将验收操作和临时产物限定在本轮新建的验收房间及其导入对象，故障注入使用隔离夹具或仅影响本轮上传的作用域。

在共享部署上，先为本轮预留公开 B 站片源和分 P，默认通过网页控件手动验收。房间按规范化的 BV 号与分 P 去重。点击「创建房间并导入」前打开浏览器网络面板，提交一次并查看该次 `POST /api/rooms` 的响应。提交创建新房间时会开始导入。收到 `201` 后，核对响应的房间 ID 与页面一致，并在私有记录中确认它是本轮新建房间。此后才能分享或更换邀请、审批、重试导入或重导入、删除成品和结束房间。若收到 `200`（复用房间）或无法确认响应或归属，立即停止该次验收并离开房间，禁止对该房间继续写入。

原部署浏览器命令使用固定片源，只有在能保证它创建新房间时才使用，例如已有隔离的房间数据，或已为本轮保留脚本使用的片源且可排除同一分 P 的已有房间和并发提交。

- **故障与重试。** 在隔离的测试中注入上传故障，包括上传可能已经写入的情况。确认失败时房间无可播放地址，原房间重试后只有一个成品可读，随后房间才显示可播放。单独记录故障与重试的结果。
- **实际域成功路径。** 在 Vultr 用公开投稿验证下载、FFmpeg 封装、上传和成品可读后才显示可播放，确认运行环境只有 app 容器获得桶级凭据。在 Vercel 网页域确认 CSP 允许媒体域，登录及邀请深链接可用。用 Chromium Pixel 和 WebKit iPhone 移动模拟确认房间 API 和授权仍走 Vultr、视频直读 R2 媒体域，并验证匿名 `HEAD 200`、`Range` 请求的 `206` 和 `Content-Range`、跳转、同步暂停和重连。
- **正式配置读回。** 通过获准的只读入口核对媒体子域和 TLS、精确 CORS、绕过共享缓存的命中规则、桶内仅有成品，以及上文启用的全桶 3 天对象年龄规则。记录脱敏配置和核验结果。
- **受控删除。** 在私有记录中将本轮新建房间与其已发布的成品关联，从该房间的授权响应取得成品地址，核对媒体域、对应桶和精确对象键。经删除授权后，仅删除确认由本轮导入生成的那个对象。归属或权限未核实时，先补齐对应证据。删除后通过绕缓存的媒体域发起全新的匿名 `HEAD` 和 `Range` 请求，验证旧地址无法播放。记录状态码、绕缓存规则命中和可用的响应缓存状态。保持房间开放，确认页面提示过期、原房间重导入后能播放新地址，旧地址仍失效。验证后结束已确认归属的本轮新建房间。清理剩余成品前逐一核对其确切对象键和归属，并只清理获准删除的本轮对象。规则读回与受控删除分别记录，后者验证过期体验。若另需观察生命周期自动执行，可用已有且归属与对象年龄可核验的到龄对象，单独记录异步删除结果。

记录状态码、浏览器版本及行为结果即可。验收材料保存在私有位置，公开记录使用占位域名和脱敏结果。
