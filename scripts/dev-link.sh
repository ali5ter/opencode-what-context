#!/usr/bin/env bash
#
# dev-link.sh - Create the local OpenCode plugin loader for this checkout
#
# Copies the tracked loader template from dev/plugins/ into .opencode/plugins/,
# where OpenCode discovers it and runs the checkout's source live. Idempotent:
# re-running refreshes the generated loader from the template.
#
# Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
# Version: 1.0.0
# Date: 2026-11-20
# License: MIT
#
# Usage: scripts/dev-link.sh
#
# Dependencies: bash 3.2+, pfb
#
# Exit codes:
#   0 - Loader created or refreshed
#   1 - The template directory is missing or the copy failed
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
template_dir="$repo_root/dev/plugins/opencode-what-context"
target_dir="$repo_root/.opencode/plugins/opencode-what-context"

pfb heading "Local plugin loader" "🔌"

if [[ ! -d "$template_dir" ]]; then
  pfb error "Template directory not found: $template_dir — run this script from a full clone of the repo"
  exit 1
fi

mkdir -p "$target_dir"
cp -R "$template_dir/." "$target_dir/"
pfb success "Loader written to .opencode/plugins/opencode-what-context/"

if [[ ! -d "$repo_root/node_modules" ]]; then
  pfb warn "node_modules is missing — the loader imports from it; run 'npm install' in the repo root"
fi
