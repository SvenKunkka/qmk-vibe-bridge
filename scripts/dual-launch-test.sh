#!/usr/bin/env bash
# Round-9/10/11/12 dual-launch regression test — SAFE ISOLATION + NON-DESTRUCTIVE.
#
# Safety contract (rounds 10-12):
#  - every run uses its own mktemp -d; all temp files live inside it;
#  - primary/secondary share an isolated AI_CONSOLE_USER_DATA lock domain;
#  - the pre-existing /tmp/ai-main-debug.log sentinel (if any) is NEVER
#    deleted, cleared or overwritten — we snapshot it and assert it is
#    byte/stat-identical afterwards (or still absent);
#  - every pid we signal is verified against a non-driftable identity:
#    pidfile content + command snapshot captured this run, or a
#    --user-data-dir=<domain> match with a real PPID under our main pid;
#  - cleanup is idempotent (CLEANED flag), kills with TERM -> bounded wait ->
#    KILL, verifies no leftovers in the domain, THEN removes the mktemp dir.
#  - NO pkill -f on product names / Electron / broad paths, ever.
#
# Usage: dual-launch-test.sh [packaged-app-path | dev]

set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_PATH=""
DEV=0
if [ "${1:-}" = "dev" ]; then
  DEV=1
elif [ -n "${1:-}" ]; then
  APP_PATH="$1"
else
  APP_PATH="$ROOT/app/release/mac-arm64/AI Keyboard Console.app"
fi

TDIR="$(mktemp -d /tmp/dual-launch.XXXXXX)"
UDATA="$TDIR/userdata"
CFG="$TDIR/config.json"
L1="$TDIR/primary.log"
L2="$TDIR/secondary.log"
EXIT_FILE="$TDIR/secondary.exit"
PIDFILE="$UDATA/main.pid"
DEBUG_LOG="$UDATA/main-debug.log"
SENTINEL="/tmp/ai-main-debug.log"
mkdir -p "$UDATA"

FAIL=0
CLEANED=0
MAIN_PID=""
MAIN_CMD=""
SHELL_PID=""
SHELL_CMD=""
SECOND_SHELL=""
SECOND_SHELL_CMD=""
ok() { echo "  ok   $1"; }
fail() { FAIL=1; echo "  FAIL $1"; }

# ---------- sentinel snapshot (NEVER delete a pre-existing file) ----------
stat_info() { # file -> "inode size mtime" (macOS then Linux)
  stat -f "%i %z %m" "$1" 2>/dev/null || stat -c "%i %s %Y" "$1" 2>/dev/null || echo "?"
}
SENTINEL_EXISTED=0
SENTINEL_STAT_BEFORE=""
SENTINEL_HASH_BEFORE=""
if [ -e "$SENTINEL" ]; then
  SENTINEL_EXISTED=1
  SENTINEL_STAT_BEFORE=$(stat_info "$SENTINEL")
  SENTINEL_HASH_BEFORE=$(shasum -a 256 "$SENTINEL" 2>/dev/null | awk '{print $1}')
  echo "  note  sentinel $SENTINEL existed before test (stat=$SENTINEL_STAT_BEFORE hash=$SENTINEL_HASH_BEFORE)"
else
  echo "  note  sentinel $SENTINEL absent before test"
fi

# ---------- static assertions: no code/bundle path may reference it ----------
if grep -qF '"/tmp/ai-main-debug.log"' "$ROOT/app/dist/main/index.js" 2>/dev/null; then
  fail "built bundle still contains the global debug path literal"
else
  ok "static: built bundle contains no global debug path literal"
fi
if grep -qF 'debugFilePath = isolatedUserData' "$ROOT/app/src/main/index.ts" 2>/dev/null; then
  ok "static: source wires debugFilePath only to the isolation env"
else
  fail "static: source does not gate debugFilePath on isolation env"
fi

# ---------- pid identity (non-driftable) ----------
snapshot_command() { ps -o command= -p "$1" 2>/dev/null || echo ""; }
pid_matches_snapshot() { # pid snapshot -> 0/1
  local pid="$1" snap="$2"
  [ -n "$snap" ] || return 1
  local cur
  cur=$(ps -o command= -p "$pid" 2>/dev/null) || return 1
  [ "$cur" = "$snap" ]
}
pid_in_domain() { # only signal pids proven to belong to THIS run
  local pid="$1"
  [ -n "$pid" ] || return 1
  if [ "$pid" = "$MAIN_PID" ] && [ "$(cat "$PIDFILE" 2>/dev/null)" = "$MAIN_PID" ] && pid_matches_snapshot "$pid" "$MAIN_CMD"; then return 0; fi
  if [ "$pid" = "$SHELL_PID" ] && pid_matches_snapshot "$pid" "$SHELL_CMD"; then return 0; fi
  if [ "$pid" = "$SECOND_SHELL" ] && pid_matches_snapshot "$pid" "$SECOND_SHELL_CMD"; then return 0; fi
  # helper: must carry our user-data-dir AND have a REAL ppid == MAIN_PID
  if ps -o command= -p "$pid" 2>/dev/null | grep -q -- "--user-data-dir=$UDATA"; then
    local ppid
    ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ "$ppid" = "$MAIN_PID" ] && return 0
  fi
  return 1
}
kill_graceful() { # TERM -> up to 3s wait -> KILL; only verified pids
  local pid="$1"
  pid_in_domain "$pid" || return 0
  if ! kill -0 "$pid" 2>/dev/null; then return 0; fi
  kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 6); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.5
  done
  kill -9 "$pid" 2>/dev/null || true
}

# ---------- idempotent cleanup: stop+verify first, THEN remove the dir ----------
kill_domain_helpers() {
  [ -n "$MAIN_PID" ] || return 0
  # correct field order: pid=, ppid=, command=  (ppid is field 2)
  for hp in $(ps -ax -o pid=,ppid=,command= | awk -v p="$MAIN_PID" -v u="$UDATA" '$2==p && index($0, "--user-data-dir=" u) > 0 {print $1}'); do
    kill_graceful "$hp"
  done
}
cleanup() {
  [ "$CLEANED" = 1 ] && return
  CLEANED=1
  kill_domain_helpers
  kill_graceful "$MAIN_PID"
  kill_graceful "$SHELL_PID"
  kill_graceful "$SECOND_SHELL"
  for lp in $(ps -ax -o pid=,command= | awk -v u="$UDATA" 'index($0, "--user-data-dir=" u) > 0 {print $1}'); do
    kill_graceful "$lp"
  done
  sleep 1
  rm -rf "$TDIR" # remove the private dir only after processes are gone
}
trap cleanup EXIT

cat > "$CFG" <<'JSON'
{ "locale": "en", "executor": "off", "agentSources": [], "devices": [] }
JSON

# ---------- self-check: fresh domain must be clean ----------
LEFT=$(ps -ax -o command | grep -- "--user-data-dir=$UDATA" | grep -v grep | wc -l | tr -d ' ')
if [ "$LEFT" -ne 0 ]; then
  fail "self-check: domain $UDATA already has $LEFT processes"
  exit 1
fi
ok "self-check: isolation domain clean at start ($UDATA)"

if [ "$DEV" -eq 1 ]; then
  RUN=("$ROOT/node_modules/.bin/electron" .)
  RUN_DIR="$ROOT/app"
else
  if [ ! -d "$APP_PATH" ]; then
    echo "packaged app not found: $APP_PATH — run npm run pack:mac first (or pass 'dev')"
    exit 2
  fi
  RUN=("$APP_PATH/Contents/MacOS/AI Keyboard Console")
  RUN_DIR="$ROOT"
fi

export AI_CONSOLE_CONFIG="$CFG"
export AI_CONSOLE_USER_DATA="$UDATA"
echo "dual-launch test (dev=$DEV) isolation=$UDATA"

# ---------- primary instance ----------
( cd "$RUN_DIR" && "${RUN[@]}" > "$L1" 2>&1 ) &
SHELL_PID=$!
SHELL_CMD=$(snapshot_command "$SHELL_PID")

READY=0
for i in $(seq 1 60); do
  if [ -s "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    MAIN_PID=$(cat "$PIDFILE")
    MAIN_CMD=$(snapshot_command "$MAIN_PID")
    READY=1
    break
  fi
  if ! kill -0 "$SHELL_PID" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ "$READY" -ne 1 ]; then
  fail "primary did not become ready — log tail: $(tail -3 "$L1" 2>/dev/null)"
  exit 1
fi
ok "primary running (main pid=$MAIN_PID, subshell pid=$SHELL_PID)"

# ---------- second instance ----------
SECOND_EXIT=""
( cd "$RUN_DIR" && "${RUN[@]}" > "$L2" 2>&1; echo $? > "$EXIT_FILE" ) &
SECOND_SHELL=$!
SECOND_SHELL_CMD=$(snapshot_command "$SECOND_SHELL")
for i in $(seq 1 30); do
  if [ -s "$EXIT_FILE" ]; then
    SECOND_EXIT=$(cat "$EXIT_FILE")
    break
  fi
  if ! kill -0 "$SECOND_SHELL" 2>/dev/null; then SECOND_EXIT="gone"; break; fi
  sleep 0.5
done
if [ -z "$SECOND_EXIT" ]; then
  fail "second instance did not exit within 15s"
  kill_graceful "$SECOND_SHELL" # verified against its own snapshot
else
  if [ "$SECOND_EXIT" != "0" ]; then
    fail "second instance exit code = $SECOND_EXIT (expected 0)"
  else
    ok "second instance exited 0"
  fi
fi

# ---------- assertions ----------
if [ -s "$PIDFILE" ] && [ "$(cat "$PIDFILE" 2>/dev/null)" = "$MAIN_PID" ]; then
  ok "single main pid in domain (pidfile: $MAIN_PID; second never initialized)"
else
  fail "pidfile does not hold exactly the primary pid"
fi
if kill -0 "$MAIN_PID" 2>/dev/null && pid_matches_snapshot "$MAIN_PID" "$MAIN_CMD"; then
  ok "primary main process still alive after second exit (identity verified)"
else
  fail "primary main process died or identity drifted"
fi
if grep -q "second-instance event" "$DEBUG_LOG" 2>/dev/null; then
  ok "primary received second-instance event"
else
  fail "primary did not log second-instance event"
fi
if [ "$DEV" -eq 1 ]; then
  if grep -q "node-hid loaded" "$L2" 2>/dev/null || grep -q "HID transport registered" "$L2" 2>/dev/null || grep -q "global F13-F24 shortcuts registered" "$L2" 2>/dev/null; then
    fail "second instance logged initialization"
  else
    ok "second instance: no init logs"
  fi
fi

# ---------- production no-op: sentinel must be untouched / still absent ----------
PROD_HOME="$TDIR/prod-home"
mkdir -p "$PROD_HOME"
( cd "$ROOT/app" && env -u AI_CONSOLE_USER_DATA HOME="$PROD_HOME" "$ROOT/node_modules/.bin/electron" . --smoke-test > "$TDIR/prod.log" 2>&1 )
PROD_EXIT=$?
if [ "$PROD_EXIT" -ne 0 ]; then
  fail "production-mode smoke failed (exit $PROD_EXIT)"
else
  ok "production-mode smoke exited 0"
fi
if [ "$SENTINEL_EXISTED" = 1 ]; then
  SENTINEL_STAT_AFTER=$(stat_info "$SENTINEL")
  SENTINEL_HASH_AFTER=$(shasum -a 256 "$SENTINEL" 2>/dev/null | awk '{print $1}')
  if [ "$SENTINEL_STAT_BEFORE" = "$SENTINEL_STAT_AFTER" ] && [ "$SENTINEL_HASH_BEFORE" = "$SENTINEL_HASH_AFTER" ]; then
    ok "pre-existing sentinel untouched (stat+hash identical)"
  else
    fail "pre-existing sentinel was modified (stat or hash changed)"
  fi
else
  if [ -e "$SENTINEL" ]; then
    fail "sentinel appeared during production-mode smoke (must stay absent)"
  else
    ok "sentinel still absent after production-mode smoke"
  fi
fi

# ---------- final self-check: clean, verify no leftovers, THEN remove dir ----------
cleanup
sleep 1
LEFT_AFTER=$(ps -ax -o command | grep -- "--user-data-dir=$UDATA" | grep -v grep | wc -l | tr -d ' ')
if [ "$LEFT_AFTER" -eq 0 ]; then
  ok "self-check: no leftover processes in isolation domain after cleanup"
else
  fail "self-check: $LEFT_AFTER leftover processes still in domain"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "DUAL-LAUNCH OK"
  exit 0
else
  echo "DUAL-LAUNCH FAILED"
  exit 1
fi
