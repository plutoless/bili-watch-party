#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

release=$1
export RELEASE_SHA=$2
api_origin=$3
web_origin=$4
config="$HOME/.config/bili-watch-party"

fail() { printf '%s\n' "$1"; exit 1; }

[[ $RELEASE_SHA =~ ^[0-9a-f]{40}$ && -r $config/compose.env && -r $config/compose-project ]] ||
  fail '后台配置缺失或 SHA 无效。'
COMPOSE_PROJECT_NAME=$(<"$config/compose-project")
[[ $COMPOSE_PROJECT_NAME =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail 'Compose 项目名无效。'
export COMPOSE_PROJECT_NAME
cd "$release"
compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$config/compose.env")
if [[ -e .ci-r2 || -n ${5:-} ]]; then
  r2_file=${5:-}
  r2_dir=${r2_file%/*}
  private_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1" 2>/dev/null; }
  [[ $r2_file == /* && -f $r2_file && ! -L $r2_file && -O $r2_file &&
     $(private_mode "$r2_file") == 600 && -d $r2_dir && ! -L $r2_dir &&
     -O $r2_dir && $(private_mode "$r2_dir") == 700 ]] ||
    fail '后台 CI R2 配置缺失、归属错误或权限不安全。'
  # Compose prefers the process environment over either env file.
  unset MEDIA_ORIGIN R2_ACCOUNT_ID R2_BUCKET R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY
  compose+=(--env-file "$r2_file")
fi
compose+=(-f compose.yaml -f compose.release.yaml)

if ! "${compose[@]}" config --format json 2>/dev/null | jq -e \
  --arg api "$api_origin" --arg web "$web_origin" \
  '.services.app.environment.PUBLIC_ORIGIN == $api and
   .services.caddy.environment.PUBLIC_ORIGIN == $api and
   .services.app.environment.WEB_ORIGIN == $web' >/dev/null 2>&1; then
  fail '后台 Compose 配置无效，或 HTTPS Origin 与 Actions 不一致。'
fi
printf '后台构建 %s\n' "$RELEASE_SHA"
if ! "${compose[@]}" build app >/dev/null 2>&1 ||
   ! "${compose[@]}" pull --policy missing caddy >/dev/null 2>&1; then
  fail '后台镜像构建或拉取失败，现有容器仍在运行。'
fi
printf '%s\n' '后台更新与 Compose 健康检查'
if ! "${compose[@]}" up -d --no-build --pull never --force-recreate --wait --wait-timeout 60 >/dev/null 2>&1; then
  fail 'Compose 启动或健康检查失败，请在后台主机检查服务。'
fi
printf 'Compose 健康检查通过 %s\n' "$RELEASE_SHA"
