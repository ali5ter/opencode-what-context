// Local development loader: the TUI discovers the plugin directory and resolves the
// conventional `tui` root file (Bun resolves the extension to .tsx; the OpenTUI solid
// transform compiles it at runtime). Delegates to the real TUI source in `src/`.
export { default } from "../../../src/tui.tsx"
