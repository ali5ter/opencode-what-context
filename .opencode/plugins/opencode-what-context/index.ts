// Local development loader: the directory is auto-discovered by both the server (which
// admits directories and loose .ts/.js files) and the TUI (which admits directories
// only), so the directory basename is the plugin package id. Delegates to the real
// plugin source in `src/`.
export { default } from "../../../src/index.ts"
