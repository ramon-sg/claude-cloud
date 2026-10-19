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
"${COMPOSE[@]}" up -d --build >"$TMP/compose.log" 2>&1 || { cat "$TMP/compose.log" >&2; fail "docker compose up failed"; }
ready=""
for _ in $(seq 1 30); do
  if in_box 'curl -sI -o /dev/null https://registry.npmjs.org/' 2>/dev/null; then ready=1; break; fi
  sleep 1
done
[ -n "$ready" ] || fail "the proxy did not let the box reach registry.npmjs.org within 30 seconds"

echo "== the box has no route out except the proxy"
if in_box 'curl -sS --noproxy "*" --max-time 5 -o /dev/null https://registry.npmjs.org/' 2>/dev/null; then
  fail "the box reached registry.npmjs.org without the proxy"
fi
echo "ok: direct egress from the box fails"

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
# NOTE: the fixture pins the packed version, so setup runs this build instead of relaunching
# another one from npm.
in_box "node -e \"
const fs = require('fs');
const f = '/work/fixture/.claude/cloud.json';
const c = JSON.parse(fs.readFileSync(f, 'utf8'));
c.version = '$VERSION';
fs.writeFileSync(f, JSON.stringify(c, null, 2));
\""
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
expect_output "self install copy" "$VERSION" "node -p \"require('/opt/claude-cloud/pkg/$VERSION/node_modules/@ramon-sg/claude-cloud/package.json').version\""
expect_output "installed binary" "$VERSION" '/opt/claude-cloud/bin/claude-cloud --version'

echo "== session, through the installed copy, writes the PATH line"
in_box 'rm -f /tmp/env; npm uninstall -g @ramon-sg/claude-cloud >/dev/null 2>&1; ! command -v claude-cloud' || fail "the global install is still on PATH"
in_box 'cd /work/fixture && CLAUDE_PROJECT_DIR=/work/fixture CLAUDE_CODE_REMOTE=true CLAUDE_ENV_FILE=/tmp/env /opt/claude-cloud/bin/claude-cloud session >/tmp/session.out 2>/tmp/session.err' || fail "claude-cloud session failed"
in_box 'grep -q "^export PATH=\"/opt/claude-cloud/node-24.14.1/bin:/opt/claude-cloud/bun-1.4.2/node_modules/.bin:/opt/claude-cloud/bin:\$PATH\"" /tmp/env' \
  || fail "wrong PATH line in the env file: $(in_box 'cat /tmp/env /tmp/session.out 2>&1')"
echo "ok: session wrote the PATH line"
expect_output "claude-cloud on the session PATH" "/opt/claude-cloud/bin/claude-cloud" '. /tmp/env && command -v claude-cloud'

echo "== doctor checks the network through the proxy"
in_box '. /tmp/env && cd /work/fixture && claude-cloud doctor >/tmp/doctor.out 2>&1' || true
doctor="$(in_box 'cat /tmp/doctor.out')"
echo "$doctor"
grep -qx "claude-cloud: network registry.npmjs.org: ok" <<<"$doctor" || fail "doctor did not reach registry.npmjs.org"
grep -qx "claude-cloud: network api.github.com: blocked" <<<"$doctor" || fail "doctor did not report api.github.com as blocked"
grep -qx "claude-cloud: tool node 24.14.1: ok" <<<"$doctor" || fail "doctor did not find node"
echo "ok: doctor saw npm reachable and GitHub blocked"

echo "PASS: container walkthrough"
