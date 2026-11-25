#!/usr/bin/env bash
set -euo pipefail
umask 077

# Runs against a local Linux Docker Engine with loopback port 18443 free.
[[ $(uname -s) == Linux ]] || { echo 'Compose fixture requires Linux.'; exit 1; }
fixture=$(mktemp -d)
project=watch-release-${fixture##*.}
project=${project,,}
api=https://localhost:18443
web=https://watch.example.org
server_config="$fixture/home/.config/bili-watch-party"
mkdir -p "$server_config" "$fixture/first" "$fixture/upgrade"
printf '%s\n' "$project" >"$server_config/compose-project"
printf '%s\n' "PUBLIC_ORIGIN=$api" "WEB_ORIGIN=$web" 'HOST_PASSWORD=synthetic-test-password' \
  'WATCH_BIND_IP=127.0.0.1' 'WATCH_HTTPS_PORT=18443' \
  "WATCH_DATA_VOLUME=$project-rooms" "WATCH_TLS_VOLUME=$project-tls" >"$server_config/compose.env"

first=1111111111111111111111111111111111111111
second=2222222222222222222222222222222222222222
third=3333333333333333333333333333333333333333
for directory in "$fixture/first" "$fixture/upgrade"; do
  cp -pR Dockerfile .dockerignore compose.yaml compose.release.yaml package.json package-lock.json src public "$directory"
  # HTTPS on the fixture port is sufficient. Leave the runner's HTTP port available.
  sed -i '/WATCH_BIND_IP.*:80:80/d' "$directory/compose.yaml"
  printf '%s\n' '{' 'admin off' 'skip_install_trust' 'auto_https disable_redirects' '}' \
    '{$PUBLIC_ORIGIN} {' 'tls internal' 'reverse_proxy 127.0.0.1:3000' '}' >"$directory/Caddyfile"
done

compose() {
  COMPOSE_PROJECT_NAME=$project RELEASE_SHA=$1 docker compose --project-name "$project" \
    --env-file "$server_config/compose.env" -f "$2/compose.yaml" -f "$2/compose.release.yaml" "${@:3}"
}

cleanup() {
  compose "$first" "$fixture/first" down --volumes >/dev/null 2>&1 || true
  docker image rm "$project-app:$first" "$project-app:$second" "$project-app:$third" >/dev/null 2>&1 || true
  rm -rf "$fixture"
}
trap cleanup EXIT

export FIXTURE_DOCKER_ERROR="$fixture/docker-error"
docker() {
  command docker "$@" 2>"$FIXTURE_DOCKER_ERROR"
}
export -f docker

deploy() {
  if ! HOME="$fixture/home" bash scripts/deploy-backend.sh "$2" "$1" "$api" "$web"; then
    grep -Eio 'address already in use|container .* exited|container .* is unhealthy|not found|permission denied|network .* does not exist|port is already allocated|bind source path does not exist|cannot join.*' \
      "$FIXTURE_DOCKER_ERROR" || true
    compose "$1" "$2" ps --all --format json | jq -c '{Service, State, Health, ExitCode}' || true
    compose "$1" "$2" logs --tail 30 app caddy | grep -Eio \
      'E[A-Z]{3,}|ERR_[A-Z_]+|unable to open database file|database is locked|MODULE_NOT_FOUND|Cannot find module|TypeError|SyntaxError|ReferenceError|必须是 HTTPS 源地址|设置至少 16 字符|房间保留期限必须是正数|拆分部署需要不同' |
      sort -u || true
    exit 1
  fi
}

check_https() {
  curl --fail --silent --show-error --retry 8 --retry-all-errors --retry-delay 1 \
    --cacert "$fixture/root.crt" -H "Origin: $web" "$api/api/release" |
    jq -e --arg sha "$1" '.sha == $sha' >/dev/null
}

deploy "$first" "$fixture/first"
compose "$first" "$fixture/first" cp caddy:/data/caddy/pki/authorities/local/root.crt "$fixture/root.crt"
check_https "$first"
compose "$first" "$fixture/first" exec -T app sh -c 'printf synthetic > /data/release-fixture'
for sha in "$second" "$third"; do
  deploy "$sha" "$fixture/upgrade"
  check_https "$sha"
  [[ $(compose "$sha" "$fixture/upgrade" exec -T app cat /data/release-fixture) == synthetic ]]
  compose "$sha" "$fixture/upgrade" cp caddy:/data/caddy/pki/authorities/local/root.crt "$fixture/root-after.crt"
  cmp "$fixture/root.crt" "$fixture/root-after.crt"
done
printf '%s\n' 'Isolated first release and two upgrades verified with existing data and Caddy CA volumes.'
