#!/usr/bin/env bash
set -euo pipefail
umask 077
export LC_ALL=C

fail() { printf '%s\n' "$1" >&2; exit 1; }

# Rechecking inside the production concurrency group covers queued runs and old retries.
[[ ${RELEASE_SHA:-} =~ ^[0-9a-f]{40}$ && $(git rev-parse HEAD) == "$RELEASE_SHA" ]] ||
  fail '发布提交与验证的 SHA 不一致。'
current_main() {
  local head
  head=$(git ls-remote --exit-code origin refs/heads/main 2>/dev/null) || fail '无法核对远端 main。'
  if [[ ${head%%$'\t'*} != "$RELEASE_SHA" ]]; then
    printf '跳过 %s，main 已变化。\n' "$RELEASE_SHA"
    exit 0
  fi
}
current_main
printf '生产发布目标 %s\n' "$RELEASE_SHA"

for name in DEPLOY_SSH_HOST DEPLOY_SSH_USER DEPLOY_SSH_KEY DEPLOY_SSH_KNOWN_HOSTS \
    API_ORIGIN WEB_ORIGIN VERCEL_ORG_ID VERCEL_PROJECT_ID VERCEL_TOKEN; do
  [[ -n ${!name:-} ]] || fail "缺少生产发布配置 $name。"
done
port=${DEPLOY_SSH_PORT:-22}
[[ $port =~ ^[1-9][0-9]{0,4}$ ]] && (( port <= 65535 )) || fail 'SSH 端口无效。'
[[ $DEPLOY_SSH_HOST =~ ^[a-zA-Z0-9][a-zA-Z0-9.:-]*$ &&
   $DEPLOY_SSH_USER =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || fail 'SSH 地址或账号无效。'
[[ $VERCEL_ORG_ID =~ ^[a-zA-Z0-9_]+$ && $VERCEL_PROJECT_ID =~ ^prj_[a-zA-Z0-9]+$ ]] ||
  fail 'Vercel 项目标识无效。'
if ! node -e '
  const [api, web] = process.argv.slice(1).map(value => {
    const url = URL.parse(value);
    if (url?.protocol !== "https:" || url.origin !== value || !/^[a-z0-9.-]+$/.test(url.hostname)) {
      process.exit(1);
    }
    return url;
  });
  if (api.origin === web.origin || web.port) process.exit(1);
' "$API_ORIGIN" "$WEB_ORIGIN"; then
  fail '两个 HTTPS Origin 必须不同，网页 Origin 使用标准 HTTPS 端口。'
fi
web_host=${WEB_ORIGIN#https://}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

printf '%s\n' "$DEPLOY_SSH_KEY" >"$work/key"
printf '%s\n' "$DEPLOY_SSH_KNOWN_HOSTS" >"$work/known_hosts"
unset DEPLOY_SSH_KEY DEPLOY_SSH_KNOWN_HOSTS
known_host=$DEPLOY_SSH_HOST
if [[ $port != 22 ]]; then known_host="[$DEPLOY_SSH_HOST]:$port"; fi
ssh-keygen -F "$known_host" -f "$work/known_hosts" >/dev/null 2>&1 ||
  fail 'SSH 主机密钥配置缺少该地址与端口的记录。'
ssh_command=(ssh -F /dev/null -p "$port" -i "$work/key"
  -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
  -o "UserKnownHostsFile=$work/known_hosts" -o GlobalKnownHostsFile=/dev/null
  -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=3
  "$DEPLOY_SSH_USER@$DEPLOY_SSH_HOST")

printf '%s\n' 'SSH 连接与主机身份检查'
if ! "${ssh_command[@]}" true </dev/null >/dev/null 2>"$work/ssh-error"; then
  if grep -Eqi 'host key verification failed|host identification has changed|no matching host key type' "$work/ssh-error"; then
    fail 'SSH 主机密钥校验失败。'
  elif grep -Eqi 'permission denied|invalid format|load key' "$work/ssh-error"; then
    fail 'SSH 专用密钥或账号认证失败。'
  fi
  fail 'SSH 不可达，请检查地址、端口及 runner 网络。'
fi
printf '%s\n' 'SSH 检查通过'

git archive --format=tar --output="$work/backend.tar" "$RELEASE_SHA" \
  Dockerfile .dockerignore compose.yaml compose.release.yaml Caddyfile package.json src public scripts/deploy-backend.sh
mkdir -p "$work/web/.vercel"
git archive "$RELEASE_SHA" vercel.json package.json package-lock.json public scripts/build-web.js |
  tar -x -C "$work/web"
printf '{"orgId":"%s","projectId":"%s","settings":{"framework":null,"nodeVersion":"24.x","installCommand":""}}\n' \
  "$VERCEL_ORG_ID" "$VERCEL_PROJECT_ID" >"$work/web/.vercel/project.json"
vercel_cli=(vercel --cwd "$work/web")
printf '网页构建 %s\n' "$RELEASE_SHA"
env -u VERCEL_TOKEN -u VERCEL_AUTOMATION_BYPASS_SECRET \
  "${vercel_cli[@]}" build --prod >/dev/null 2>&1 || fail 'Vercel 网页构建失败。'
index="$work/web/.vercel/output/static/index.html"
grep -Fq "name=\"watch-release\" content=\"$RELEASE_SHA\"" "$index" 2>/dev/null ||
  fail 'Vercel 产物缺少通过验证的提交标识。'

curl_request() {
  curl --disable --silent --show-error --connect-timeout 10 --max-time 20 "$@" 2>/dev/null
}

vercel_api() {
  local query=''
  if [[ $VERCEL_ORG_ID == team_* ]]; then query="?teamId=$VERCEL_ORG_ID"; fi
  curl_request -H "Authorization: Bearer $VERCEL_TOKEN" \
    -o "$work/vercel-response" -w '%{http_code}' "https://api.vercel.com$1$query"
}

previous_web() {
  local status
  status=$(vercel_api "/v4/aliases/$web_host") || return 1
  case "$status" in
    404) return 0 ;;
    200) jq -er --arg project "$VERCEL_PROJECT_ID" \
      'select(.projectId == $project) | .deploymentId | select(test("^dpl_[A-Za-z0-9]+$"))' \
      "$work/vercel-response" 2>/dev/null ;;
    *) return 1 ;;
  esac
}

check_web() {
  local origin=$1 status path
  shift
  for path in / /rooms/00000000-0000-4000-8000-000000000000 /invite/00000000-0000-4000-8000-000000000000; do
    status=$(curl_request "$@" -o "$work/page" -w '%{http_code}' "$origin$path?release=$RELEASE_SHA") &&
      [[ $status == 200 ]] && cmp -s "$index" "$work/page" || return 1
  done
}

printf '%s\n' 'Vercel 正式域名配置检查与候选网页部署'
[[ $(vercel_api "/v9/projects/$VERCEL_PROJECT_ID/domains/$web_host") == 200 ]] &&
  jq -e '.verified == true and .redirect == null and .gitBranch == null' \
    "$work/vercel-response" >/dev/null 2>&1 || fail 'Vercel 正式域名未验证或未绑定到项目的生产环境。'
prior=$(previous_web) || fail '无法读取上一个正式网页部署。'
staged=$("${vercel_cli[@]}" deploy --prebuilt --prod --skip-domain --yes --token "$VERCEL_TOKEN" 2>/dev/null) ||
  fail 'Vercel 候选网页部署失败，正式域名保持原版本。'
[[ $staged =~ ^https://[a-zA-Z0-9-]+\.vercel\.app$ ]] || fail 'Vercel 候选网页地址无效。'
stage_headers=(-H 'Accept: text/html')
if [[ -n ${VERCEL_AUTOMATION_BYPASS_SECRET:-} ]]; then
  stage_headers+=(-H "x-vercel-protection-bypass: $VERCEL_AUTOMATION_BYPASS_SECRET")
fi
check_web "$staged" "${stage_headers[@]}" || fail '候选网页 HTTPS 或深链接检查失败。'
printf '候选网页 HTTPS 与深链接检查通过 %s\n' "$RELEASE_SHA"

current_main
remote_command='set -eu
  umask 077
  root="$HOME/.local/share/bili-watch-party-deploy"
  mkdir -p "$root/releases"
  exec 9>"$root/deploy.lock"
  flock -w 120 9 || { echo "后台发布锁超时。"; exit 1; }
  dir=$(mktemp -d "$root/releases/$1.XXXXXXXX")
  # Keep tracked source readable by the image user inside the private host directory.
  tar -xpf - -C "$dir"
  bash "$dir/scripts/deploy-backend.sh" "$dir" "$@"'
"${ssh_command[@]}" "bash -c '$remote_command' bash $RELEASE_SHA $API_ORIGIN $WEB_ORIGIN" \
  <"$work/backend.tar" 2>"$work/ssh-error" || fail '后台部署失败，正式网页未切换。'

check_backend() {
  local status
  status=$(curl_request -H "Origin: $WEB_ORIGIN" -D "$work/headers" -o "$work/backend" \
    -w '%{http_code}' "$API_ORIGIN/api/release") && [[ $status == 200 ]] &&
    jq -e --arg sha "$RELEASE_SHA" '.sha == $sha' "$work/backend" >/dev/null 2>&1 &&
    tr -d '\r' <"$work/headers" | grep -Fxi "Access-Control-Allow-Origin: $WEB_ORIGIN" >/dev/null &&
    tr -d '\r' <"$work/headers" | grep -Fxi 'Access-Control-Allow-Credentials: true' >/dev/null &&
    [[ $(curl_request -H "Origin: $WEB_ORIGIN" -o /dev/null -w '%{http_code}' "$API_ORIGIN/api/session") == 401 ]]
}

retry_check() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if "$@"; then return 0; fi
    if [[ $attempt != 6 ]]; then sleep 5; fi
  done
  return 1
}

printf '%s\n' '后台正式 HTTPS 检查'
retry_check check_backend || fail '后台 HTTPS、版本或跨源检查失败，正式网页未切换。'
printf '后台正式 HTTPS 检查通过 %s\n' "$RELEASE_SHA"
current_main

promote() {
  "${vercel_cli[@]}" promote "$1" --yes --token "$VERCEL_TOKEN" >/dev/null 2>&1
}

check_previous_web() {
  [[ $(previous_web) == "$prior" &&
     $(curl_request -o /dev/null -w '%{http_code}' "$WEB_ORIGIN/") == 200 ]]
}

printf '%s\n' '切换 Vercel 正式网页并检查 HTTPS'
if ! promote "$staged" || ! retry_check check_web "$WEB_ORIGIN"; then
  if [[ -n $prior ]]; then
    promote "$prior" || true
    if retry_check check_previous_web; then
      fail 'Vercel 切换或正式 HTTPS 检查失败，上一个正式网页部署已恢复。后台保留通过检查的版本。'
    fi
    fail 'Vercel 切换或正式 HTTPS 检查失败，自动恢复未确认，请按发布文档检查域名。'
  fi
  fail '首次 Vercel 切换或正式 HTTPS 检查失败，请按发布文档检查域名后重试。'
fi
retry_check check_backend || fail '网页 HTTPS 已通过，后台复查失败，请按发布文档恢复。'
printf '发布通过，后台 %s，网页 %s。\n' "$RELEASE_SHA" "$RELEASE_SHA"
