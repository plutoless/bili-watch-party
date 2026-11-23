# R2 公开媒体

开启后，后台继续用 FFmpeg 复制 B 站的 H.264 画轨和 AAC 音轨，将成品封装成快速起播的 MP4。浏览器从媒体域直接请求视频片段，房间、邀请审批和同步控制仍经后台校验会话。持有公开媒体地址的人可以在对象删除前播放，即使房间已结束。房间记录、凭据、源轨道和临时文件留在后台。

## Cloudflare 配置

1. 创建默认管辖区的专用桶，仅用于成品 MP4。为 Vultr 创建范围仅限该桶的 **Object Read & Write** S3 凭据。将它保存到服务器私有配置文件。网页构建、Vercel 和 GitHub Actions 只接收公开的媒体 Origin。 [R2 凭据](https://developers.cloudflare.com/r2/api/tokens/)
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

5. 在桶的 **Settings → Object Lifecycle Rules** 新建并启用规则。前缀留空，对全桶按对象年龄在 **3 天后删除**。从 Dashboard 重新读取规则，或用另行授权的运维凭据读取 S3 的 `GetBucketLifecycleConfiguration`，核对等效规则如下。对象年龄从上传完成算起。删除异步执行，Cloudflare 说明对象通常在其到期时间后 24 小时内移除。以对象实际删除作为失效依据。 [R2 生命周期](https://developers.cloudflare.com/r2/buckets/object-lifecycles/)

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

正式验收由维护者在获授权的独立实例进行。

- 在实际 Vercel 正式域确认 CSP 允许媒体域，登录及邀请深链接可用。用 Chromium Pixel 和 WebKit iPhone 移动模拟观察房间 API 发往 Vultr，媒体请求发往 Cloudflare 媒体域。确认匿名 `HEAD 200`、片段 `206` 和 `Content-Range`，以及跳转、同步暂停和重连。
- 在实际 Vultr 验证公开投稿可下载、封装和上传。检查运行环境仅 app 容器获得桶级凭据，上传失败时无可播放地址，重试后同一导入只有一个成品。
- 在实际 R2 核对正式媒体子域及 TLS、精确 CORS、命中绕缓存规则、桶内只有成品和已启用的 3 天对象年龄规则。在独立测试桶中受控删除一个成品，用无缓存新请求确认旧地址失效，页面报过期，原房间可用新地址重新导入。需要验证自动生命周期执行时，另观察测试对象到期后的异步删除。

记录状态码、浏览器版本及行为结果即可。验收材料保存在私有位置，公开记录使用占位域名和脱敏结果。
