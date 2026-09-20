#!/usr/bin/env bash
# Governing: ADR-0003 (Go domain, thin adapter), SPEC-0005 REQ "Module Loading"
#
# Puts the four runtime artifacts the boundary needs into web/public/, which
# vite serves at / in dev and copies into dist/ on build:
#
#   planner.wasm   the compiled Go module (cmd/planner)
#   wasm_exec.js   the Go toolchain's loader shim, which defines globalThis.Go
#   tier1.json     the Tier 1 artifact the module validates on load
#   tier2.json     the Tier 2 curated constants the view fetches and checks
#
# tier2.json is copied rather than built: ADR-0001 makes Tier 2 hand-
# maintained, so data/tier2.json is the source and this only puts it where
# the browser can ask for it. It travels beside tier1.json rather than
# inside it because the two fail differently — Tier 1 failing means there is
# no graph, Tier 2 failing means the graph resolves and no producer can be
# sized — and because folding a hand-edited file into a generated one would
# make the generator's byte-for-byte reproducibility test unanswerable.
#
# None of the four is committed. wasm_exec.js belongs to whichever Go
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
install -m 0644 data/tier2.json "$PUBLIC/tier2.json"

printf 'planner.wasm  %s bytes\n' "$(wc -c < "$PUBLIC/planner.wasm")"
printf 'wasm_exec.js  %s bytes\n' "$(wc -c < "$PUBLIC/wasm_exec.js")"
printf 'tier1.json    %s bytes\n' "$(wc -c < "$PUBLIC/tier1.json")"
printf 'tier2.json    %s bytes\n' "$(wc -c < "$PUBLIC/tier2.json")"
