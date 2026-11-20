// Template for the local development loader: scripts/dev-link.sh copies this directory
// to .opencode/plugins/, where the TUI discovers it and resolves the conventional `tui`
// root file (Bun resolves the extension to .tsx; the OpenTUI solid transform compiles it
// at runtime). Delegates to the real TUI source in `src/`.
//
// Edit this file, then re-run scripts/dev-link.sh; the generated copy is gitignored.
export { default } from "../../../src/tui.tsx"
