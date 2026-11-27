# Vercel 和 Vultr 自动发布

PR 合入 `main` 后，Actions 测试并构建确切的合并 SHA。生产作业先生成暂未绑定域名的 Vercel 候选网页，并检查首页、房间与邀请深链接。随后通过 SSH 在 Vultr 构建和启动该 SHA 的后台，依次检查 Compose 健康状态、后台的 HTTPS SHA 和正式网页 Origin 的跨源访问。检查通过后才切换 Vercel 正式域名，并检查正式 HTTPS 页面与候选产物一致。

普通 PR 检查无生产凭据。直接推送、未合并关闭及合入其他分支均不会触发生产发布。生产作业串行执行，排队期间若 `main` 已前移，旧运行会跳过发布。修复配置后可从 Actions 的 **Release production → Run workflow** 选择当前 `main` 显式重试。

**合并即发布。后台重启会中断正在播放的同步，清空内存中的共享播放状态，房主需要重新登录。** 原有房间、影片和 Caddy 证书沿用服务器卷。

## 首次设置

1. 在同一可注册域名下准备两个 HTTPS 子域，例如 `watch.example.org` 和 `api-watch.example.org`。网页域按 Vercel 项目要求配置 DNS，并绑定为项目的生产域名。后台域解析到 Vultr，放行 HTTP 80 和 HTTPS 443，供 Caddy 获取证书和向浏览器提供服务。SSH 地址可以与 HTTPS 地址不同。
2. 在 Vercel 使用专用于此网页的静态项目，解绑现有 Git 集成，停用指向该项目的 Deploy Hooks，并保留上一份生产部署供恢复。仓库的 `git.deploymentEnabled: false` 也会禁用 Git 自动部署。生产域名应直接提供网页。若保护了候选部署，在 Vercel 创建可供自动化使用的 Protection Bypass，并放入对应的 Actions 环境 Secret。
3. 在 Vultr 安装 Docker Engine、Compose v2、`bash`、`tar`、`flock` 和 `jq`。创建具有独立家目录的专用 SSH 账号，允许该账号写入 `~/.local/share/bili-watch-party-deploy/`、读取下面的配置并运行 `docker compose`。能控制 Docker 的账号具有主机级权限。为 Actions 生成专用 SSH 密钥，将公钥加入该账号的 `authorized_keys`。确保部署 runner 可以访问 SSH 端口。仅有私网入口时，需为生产作业准备可信的网络路径或专用 runner。
4. 在部署账号下创建 `~/.config/bili-watch-party/`，目录权限设为 `0700`，两个配置文件权限设为 `0600`。写入 `compose-project`，内容为一行 Compose 项目名。写入 `compose.env`，设置 `PUBLIC_ORIGIN=https://api-watch.example.org`、`WEB_ORIGIN=https://watch.example.org` 和私密的 `HOST_PASSWORD`。接管已有实例时，通过服务器上的 `docker compose ls` 和容器挂载核对项目名及实际卷名，沿用原房主密码、`WATCH_DATA_VOLUME` 和 `WATCH_TLS_VOLUME`。备份现有数据和配置，并保留当前部署的源码路径，供首次升级失败时恢复。
5. 从服务器控制台或其他可信渠道核对 SSH 主机公钥指纹。为实际地址及端口创建对应的 OpenSSH `known_hosts` 记录。默认端口格式为 `ssh.example.org ssh-ed25519 <公钥>`，自定义端口格式为 `[ssh.example.org]:2222 ssh-ed25519 <公钥>`。主机密钥轮换时通过相同渠道核对，再更新环境凭据。
6. 在 GitHub Actions 创建 `production` 环境，只允许来自 `main` 的部署，按下表配置。两个 Origin 均为 HTTPS 地址，末尾省略斜杠。普通 PR 使用 GitHub 托管 runner。

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Secret | `DEPLOY_SSH_HOST`、`DEPLOY_SSH_USER` | SSH 主机名或 IP，以及专用账号 |
| Secret | `DEPLOY_SSH_KEY` | Actions 专用私钥，保留多行格式 |
| Secret | `DEPLOY_SSH_KNOWN_HOSTS` | 已核对的服务器主机公钥记录 |
| Variable | `DEPLOY_SSH_PORT` | 可选，默认 `22` |
| Secret | `VERCEL_TOKEN` | 具备目标项目部署、生产切换及查询域名权限的 Vercel token |
| Secret | `VERCEL_AUTOMATION_BYPASS_SECRET` | 可选，供 HTTPS 检查访问受保护的候选网页 |
| Variable | `VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` | Vercel 账号或团队 ID，以及网页项目 ID |
| Variable | `API_ORIGIN`、`WEB_ORIGIN` | Vultr 的后台 HTTPS Origin、Vercel 的正式网页 HTTPS Origin |
| Variable | `MEDIA_ORIGIN` | 可选。R2 公开媒体 HTTPS Origin，用于网页的媒体来源限制。启用 CI 的 R2 后台配置时必填。 |
| Variable | `R2_ACCOUNT_ID`、`R2_BUCKET` | 可选。CI 要配置的 R2 账号 ID 和本应用的成品媒体专用桶。 |
| Secret | `R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` | 可选。仅限该桶的写入凭据，通过已校验主机身份的 SSH 传给 Vultr，仅 app 容器使用。 |

CI 的 R2 后台配置由两项 R2 Variable 和两项 R2 Secret 组成。四项均留空时，后台沿用主机的 `compose.env`。填写任一项时，四项和 `MEDIA_ORIGIN` 都必填。先按 [R2 公开媒体](r2-media.md#应用配置) 发布支持媒体域的网页，再配置后台。

## 失败与恢复

- **缺少配置、SSH 不可达或主机密钥异常。** 先核对环境变量、专用账号、runner 网络路径及公开主机密钥。SSH 连通和身份探测通过后才传输后台源码。保留严格校验。
- **测试、候选网页或后台镜像构建失败。** 原容器和正式网页继续服务。修正问题后显式运行当前 `main`。Actions 只记录 SHA、阶段和结果。需要细节时在服务器或私有终端重现该阶段。
- **Compose 或后台 HTTPS 失败。** 正式网页仍指向之前的部署。检查服务器上的 Compose 状态、Caddy 证书和本地日志，修正后重试。若需尽快恢复且卷格式兼容，在发布停止时进入上一次健康 SHA 对应的 `~/.local/share/bili-watch-party-deploy/releases/<SHA>.<后缀>/`，使用同一服务器配置和项目名重启保存的镜像。第一次接管旧实例而旧版本没有发布 SHA 时，回到原源码目录，用原项目名、配置和原 Compose 启动命令恢复。

  在执行 Compose 前，确认旧镜像理解现有房间的媒体配置。若当前或失败的发布已启用 R2 并可能发布成品，必须保留可读取这些成品的媒体域、桶和有效凭据。首次启用后的回退可能需要使用新发布的私有配置文件，即使选中的旧版本此前没有该文件。仅在旧发布没有 `.ci-r2` 标记且已确认主机 `compose.env` 与相关房间兼容时，将 `R2_ROLLBACK_CONFIG` 设为 `host`。否则将其设为已核验的私有配置文件绝对路径，再运行下方命令。无法确认兼容性时暂停回退，先核查或恢复兼容配置。

  ```bash
  export COMPOSE_PROJECT_NAME=$(cat "$HOME/.config/bili-watch-party/compose-project")
  export RELEASE_SHA='<上一次健康后台的完整 SHA>'
  env_files=(--env-file "$HOME/.config/bili-watch-party/compose.env")
  # R2_ROLLBACK_CONFIG 由操作者在运行前确认。值为 host 或已验证的私有配置文件绝对路径。
  : "${R2_ROLLBACK_CONFIG:?请先确认兼容现有房间的后台配置}"
  unset MEDIA_ORIGIN R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  if [[ $R2_ROLLBACK_CONFIG == host ]]; then
    [[ ! -e .ci-r2 ]] || exit 1
  else
    r2_dir=${R2_ROLLBACK_CONFIG%/*}
    private_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
    [[ $R2_ROLLBACK_CONFIG == /* && -f $R2_ROLLBACK_CONFIG && ! -L $R2_ROLLBACK_CONFIG &&
       -O $R2_ROLLBACK_CONFIG && $(private_mode "$R2_ROLLBACK_CONFIG") == 600 &&
       -d $r2_dir && ! -L $r2_dir && -O $r2_dir && $(private_mode "$r2_dir") == 700 ]] || exit 1
    env_files+=(--env-file "$R2_ROLLBACK_CONFIG")
  fi
  docker compose --project-name "$COMPOSE_PROJECT_NAME" "${env_files[@]}" \
    -f compose.yaml -f compose.release.yaml \
    up -d --no-build --pull never --force-recreate --wait
  ```

- **Vercel 切换失败。** 流水线尝试将此前的网页部署重新设为生产，并核对正式域名。通过检查的新后台继续服务旧网页。若恢复未获确认，在 Vercel 查看生产域名的当前指向，将此前兼容的生产部署重新设为生产并验证 HTTPS。首次发布没有旧网页时，检查正式域名是否已切换，修复 DNS、证书或部署后重试。若人工恢复后台，确保它兼容当前正式网页。

CI 的 R2 配置保存在 Vultr 的私有 `r2-config` 目录。发布根目录、`releases` 和 `r2-config` 均由部署账号所有且权限为 `0700`。文件与发布目录同名并加 `.env` 后缀，权限为 `0600`。使用过 CI R2 的发布目录保留 `.ci-r2` 标记。保留恢复所需文件，并确认选中的配置仍能访问现有房间使用的媒体域和桶。发布目录、对应的私有配置和镜像供故障恢复使用。清理前在服务器核对正在运行的 Compose 容器、Caddy 的挂载来源和上一个健康版本，保留对应目录、私有配置及镜像。日常升级和恢复均保留持久卷。

## 隔离验收与首次生产记录

- `npm run check`、`npm test`、`npm run test:release` 验证代码与隔离发布流程。发布夹具使用本地 Git 仓库并替代 SSH、Compose 和 Vercel 的外部命令，覆盖默认与自定义 SSH 端口、缺失配置、主机身份异常、连接失败、构建和健康检查错误、Vercel 切换及回退、同 SHA 重试和旧 SHA 跳过。
- `npm run test:release:compose` 在独立 Linux Docker Engine 上验证首次启用和两次升级。需要回环 TCP 18443 端口、Compose v2、curl 和 jq。夹具创建专用项目和卷，使用 Caddy 本地 CA 检查 HTTPS，并验证应用数据与 CA 卷得以复用。
- 安装 Chromium、WebKit、FFmpeg 和 FFprobe 后，用 `BROWSER_SYNTHETIC_SPLIT=1 SYNTHETIC_VIDEO=1 npm run test:browser` 在回环 HTTPS 上验收旧网页对新后台的兼容性。用 `BROWSER_WEB_SOURCE` 指向上一份网页源码的私有检出，省略时使用当前网页源码。夹具生成并清理合成视频，检查移动浏览器会话、房间与邀请深链接、访客审批、授权 `206`、陌生 Origin 拒绝、播放和跳转。

实际生产首发由维护者另行启用。核对域名、凭据和既有卷后，运行当前 `main` 的 **Release production**。通过两个正式 HTTPS 域检查网页和后台的 SHA，再用公开片源在独立验收房间测试登录、审批、播放和跳转。记录 Actions 运行链接、日期、两端 SHA、HTTPS 和浏览器验收结果及是否复用原卷。配置、Cookie、邀请、媒体地址、影片及原始日志留在私有位置。
