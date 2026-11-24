#!/usr/bin/env bash
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
compose=(docker compose --project-name "$COMPOSE_PROJECT_NAME" --env-file "$config/compose.env"
  -f compose.yaml -f compose.release.yaml)

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
