#!/usr/bin/env bash
# Governing: ADR-0003 (Go domain, thin adapter), SPEC-0005 REQ "Module Loading"
#
# Puts the three runtime artifacts the boundary needs into web/public/, which
# vite serves at / in dev and copies into dist/ on build:
#
#   planner.wasm   the compiled Go module (cmd/planner)
#   wasm_exec.js   the Go toolchain's loader shim, which defines globalThis.Go
#   tier1.json     the Tier 1 artifact the module validates on load
#
# None of the three is committed. wasm_exec.js belongs to whichever Go
# toolchain built the module and MUST come from that toolchain — a mismatched
# copy fails at instantiation with an import error that reads like a
# corrupted binary. Committing it invites exactly that drift.
set -euo pipefail
cd "$(dirname "$0")/../.."

PUBLIC="web/public"
mkdir -p "$PUBLIC"

echo "building cmd/planner for js/wasm"
GOOS=js GOARCH=wasm go build -o "$PUBLIC/planner.wasm" ./cmd/planner

SHIM="$(go env GOROOT)/lib/wasm/wasm_exec.js"
if [ ! -f "$SHIM" ]; then
  echo "wasm_exec.js not found at $SHIM — is this Go toolchain complete?" >&2
  exit 1
fi
# install rather than cp: the shim is read from the Go module cache, which is
# mode 444, and a plain cp over a previous run's read-only copy fails with
# "Permission denied" on the second build rather than the first.
install -m 0644 "$SHIM" "$PUBLIC/wasm_exec.js"
install -m 0644 data/tier1.json "$PUBLIC/tier1.json"

printf 'planner.wasm  %s bytes\n' "$(wc -c < "$PUBLIC/planner.wasm")"
printf 'wasm_exec.js  %s bytes\n' "$(wc -c < "$PUBLIC/wasm_exec.js")"
printf 'tier1.json    %s bytes\n' "$(wc -c < "$PUBLIC/tier1.json")"
