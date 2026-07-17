#!/usr/bin/env bash
# Wait for a PR's CI checks to finish, and exit non-zero unless they ALL passed.
#
# WHY THIS EXISTS — the bug it replaces:
#
#   until [ "$(gh pr checks "$PR" | awk '{print $2}' | grep -c pending)" = "0" ]; do sleep 10; done
#
# That loop reads "no checks PENDING" and "no checks REPORTED" as the same thing. In the
# seconds between opening a PR and GitHub registering its workflow, `gh pr checks` prints
# "no checks reported on the ... branch" and exits 1 — the grep finds zero `pending`, the
# loop exits instantly, and the caller merges believing CI is green. It never ran. The
# failure is silent and timing-dependent: it only bites when checks register slowly, so it
# passes for weeks and then merges something unverified.
#
# The distinction this script enforces:
#   • checks not registered YET  → keep waiting (up to GRACE), never "success"
#   • checks registered, pending → keep waiting (up to TIMEOUT)
#   • checks registered, done    → PASS only if none failed/cancelled
#   • no checks after GRACE      → exit 2. Refuse to claim success for something unproven.
#
# Exit codes (distinct so a caller can react, not just "it failed"):
#   0 all checks passed · 1 a check failed/cancelled · 2 no checks registered
#   3 timed out while still pending · 64 usage error
#
# Usage: scripts/wait-checks.sh <pr-number> [timeout_s=900] [grace_s=180]
#   gh's --jq is used deliberately so this needs no `jq` on PATH.

set -uo pipefail

PR="${1:-}"
TIMEOUT="${2:-900}"
GRACE="${3:-180}"

if [ -z "$PR" ]; then
  echo "usage: $(basename "$0") <pr-number> [timeout_s] [grace_s]" >&2
  exit 64
fi

start=$SECONDS
elapsed() { echo $(( SECONDS - start )); }

while :; do
  # `|| json=""` matters: gh exits non-zero when no checks are reported. Without this,
  # `set -o pipefail` + an unguarded assignment would mask the case we most need to catch.
  json=$(gh pr checks "$PR" --json bucket,name,state 2>/dev/null) || json=""

  if [ -z "$json" ] || [ "$json" = "[]" ]; then
    if [ "$(elapsed)" -ge "$GRACE" ]; then
      echo "NO_CHECKS: no checks registered for PR #${PR} after ${GRACE}s."
      echo "Refusing to report success — CI has not run. Do not merge on this result."
      exit 2
    fi
    sleep 5
    continue
  fi

  pending=$(gh pr checks "$PR" --json bucket --jq '[.[] | select(.bucket == "pending")] | length' 2>/dev/null || echo "")
  # An unreadable count is NOT zero. Treat it as still-pending and let TIMEOUT decide.
  if [ -z "$pending" ] || ! [ "$pending" -eq "$pending" ] 2>/dev/null; then pending=1; fi

  if [ "$pending" -eq 0 ]; then
    gh pr checks "$PR" --json bucket,name --jq '.[] | "  \(.bucket)\t\(.name)"' 2>/dev/null
    bad=$(gh pr checks "$PR" --json bucket --jq '[.[] | select(.bucket == "fail" or .bucket == "cancel")] | length' 2>/dev/null || echo 1)
    if [ "$bad" -ne 0 ]; then
      echo "CHECKS FAILED for PR #${PR} (${bad} failing) — do not merge."
      exit 1
    fi
    echo "ALL GREEN for PR #${PR} ($(elapsed)s)."
    exit 0
  fi

  if [ "$(elapsed)" -ge "$TIMEOUT" ]; then
    echo "TIMEOUT: PR #${PR} still has ${pending} pending check(s) after ${TIMEOUT}s — not merging."
    exit 3
  fi
  sleep 10
done
