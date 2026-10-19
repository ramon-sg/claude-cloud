#!/usr/bin/env bash
# Walks the whole setup/session flow inside a container whose egress proxy blocks GitHub,
# using the packed tarball exactly as npm would publish it. Cleans up everything on exit.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
COMPOSE=(docker compose -f "$HERE/compose.yml")
TMP="$(mktemp -d)"

cleanup() {
  "${COMPOSE[@]}" down -v --rmi local --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

in_box() { "${COMPOSE[@]}" exec -T box bash -c "$1"; }

# Expects the command run in the box to print exactly the wanted text.
expect_output() {
  local label="$1" wanted="$2" command="$3" got
  got="$(in_box "$command" 2>&1)" || fail "$label: command failed: $command -> $got"
  [ "$got" = "$wanted" ] || fail "$label: wanted '$wanted', got '$got'"
  echo "ok: $label ($got)"
}

echo "== build the package and pack it"
(cd "$ROOT" && npm run build >/dev/null)
TARBALL="$(cd "$ROOT" && npm pack --pack-destination "$TMP" --silent | tail -n1)"
VERSION="$(cd "$ROOT" && node -p "require('./package.json').version")"
[ -f "$TMP/$TARBALL" ] || fail "npm pack did not produce $TARBALL"

echo "== start the proxy and the box"
"${COMPOSE[@]}" up -d --build >/dev/null 2>&1
for _ in $(seq 1 30); do
  in_box 'curl -sI -o /dev/null https://registry.npmjs.org/' && break
  sleep 1
done

echo "== the proxy blocks GitHub and lets npm through"
if in_box 'curl -sf -o /dev/null https://github.com'; then fail "github.com was reachable through the proxy"; fi
blocked="$(in_box 'curl -sI https://github.com 2>&1 || true')"
in_box 'curl -sS -I https://github.com 2>&1 | grep -qi "403"' || fail "github.com was not refused with 403 by the proxy: $blocked"
in_box 'curl -sf -o /dev/null https://registry.npmjs.org/' || fail "registry.npmjs.org was not reachable through the proxy"
echo "ok: github.com refused by the proxy, npm registry reachable"

echo "== install the tarball and run setup"
"${COMPOSE[@]}" cp "$TMP/$TARBALL" box:/tmp/package.tgz >/dev/null 2>&1
"${COMPOSE[@]}" cp "$HERE/fixture" box:/work/fixture >/dev/null 2>&1
in_box 'git config --global --add safe.directory "*" && cd /work/fixture && git init -q && git config user.email t@example.com && git config user.name t && git add -A && git commit -qm fixture'
in_box 'npm install -g /tmp/package.tgz >/dev/null 2>&1'
# WHY: the self install step fetches this package version from npm, and 1.0.0 is not published
# when the release is tested. Pinning the fixture to the packed version and pre-installing the
# tarball under pkg/<version> makes that step see the package already there, without the registry.
in_box "node -e \"
const fs = require('fs');
const f = '/work/fixture/.claude/cloud.json';
const c = JSON.parse(fs.readFileSync(f, 'utf8'));
c.version = '$VERSION';
fs.writeFileSync(f, JSON.stringify(c, null, 2));
\""
in_box "npm install --prefix /opt/claude-cloud/pkg/$VERSION --no-save --no-audit --no-fund /tmp/package.tgz >/dev/null 2>&1"
in_box 'CLAUDE_CLOUD_HOME=/work claude-cloud setup' || fail "claude-cloud setup exited non-zero"

echo "== assertions"
expect_output "node" "v24.14.1" '/opt/claude-cloud/node-24.14.1/bin/node -v'
expect_output "bun" "1.4.2" '/opt/claude-cloud/bun-1.4.2/node_modules/.bin/bun -v'
in_box 'dpkg -s jq >/dev/null 2>&1 && command -v jq >/dev/null' || fail "jq was not installed"
echo "ok: jq installed"
expect_output "setup step output" "built" 'cat /work/fixture/setup-ran.txt'
expect_output "state has no failed steps" "0 failed of" \
  "node -e \"
const s = JSON.parse(require('fs').readFileSync('/opt/claude-cloud/state/fixture.json', 'utf8'));
const failed = s.steps.filter((x) => !x.ok);
if (failed.length) { console.log(JSON.stringify(failed)); process.exit(1); }
console.log('0 failed of');
\""
expect_output "self install link" "/opt/claude-cloud/pkg/$VERSION/node_modules/.bin/claude-cloud" 'readlink /opt/claude-cloud/bin/claude-cloud'

echo "== session writes the PATH line"
in_box 'rm -f /tmp/env; CLAUDE_PROJECT_DIR=/work/fixture CLAUDE_CODE_REMOTE=true CLAUDE_ENV_FILE=/tmp/env claude-cloud session >/tmp/session.out 2>&1' || fail "claude-cloud session failed"
in_box 'grep -q "^export PATH=.*node-24.14.1/bin" /tmp/env' || fail "no PATH line in the env file: $(in_box 'cat /tmp/env /tmp/session.out 2>&1')"
echo "ok: session wrote the PATH line"

echo "PASS: container walkthrough"
