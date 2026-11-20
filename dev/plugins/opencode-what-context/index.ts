// Template for the local development loader: scripts/dev-link.sh copies this directory
// to .opencode/plugins/, where OpenCode discovers it (the server admits directories and
// loose .ts/.js files, the TUI directories only), so the directory basename is the plugin
// package id. Delegates to the real plugin source in `src/`.
//
// Edit this file, then re-run scripts/dev-link.sh; the generated copy is gitignored.
export { default } from "../../../src/index.ts"
