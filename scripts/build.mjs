#!/usr/bin/env node
/**
 * Build the published runtime into `dist/`.
 *
 * The TUI part of this package is solid JSX, which only behaves reactively
 * after the solid transform (babel-preset-solid, `generate: "universal"` —
 * props compiled to getters). The OpenCode host applies that transform at
 * load time, but only to files outside `node_modules` — and a package
 * installed into OpenCode's npm cache lives inside one. Untransformed, the
 * Bun runtime falls back to its default JSX (value props) and solid's
 * `Show` latches its first result: the panel renders once, empty, and never
 * updates again, with no error anywhere. That is the silent failure behind
 * the empty-panel reports on package installs (0.1.0 through 0.3.1 shipped
 * raw source).
 *
 * The published package therefore ships the transform pre-applied: `dist/`
 * is this source run through the host's own transform function, imported
 * from `@opentui/solid` (the exact machinery — `transformSolidSource` with
 * `moduleName "@opentui/solid"` — version-locked in `dependencies`). The
 * output contains no JSX and no types, so a later pass of the same
 * transform is a no-op: the package behaves identically on every load path,
 * transformed or not.
 *
 * The transform's `scripts/` subpath is not in `@opentui/solid`'s exports
 * map, so it is imported by file path. Its own babel dependencies are
 * declared by that package, so resolution does not depend on hoisting.
 *
 * `prepack` runs this at publish time, so `dist/` stays out of git.
 *
 * @returns {Promise<void>}
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { transformSolidSource } from "../node_modules/@opentui/solid/scripts/solid-transform.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, "..")
const srcDir = path.join(root, "src")
const distDir = path.join(root, "dist")

/**
 * Rewrite a relative import to its compiled name. The source imports without
 * extensions (`./context`); the dev loader tolerates that, but the published
 * `dist/` must also resolve under strict ESM, so compiled files import
 * `./context.js`. Bare specifiers pass through (null keeps the input).
 *
 * @param {string} specifier - The import specifier.
 * @returns {string | null} The rewritten specifier, or null to keep the input.
 */
function resolvePath(specifier) {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) return null
  return specifier.replace(/\.(tsx?|jsx)$/, "") + ".js"
}

const sourceFiles = (await readdir(srcDir)).filter((name) => /\.(tsx?|jsx)$/.test(name)).sort()
if (sourceFiles.length === 0) {
  throw new Error(`no source files in ${srcDir}`)
}

await rm(distDir, { recursive: true, force: true })
await mkdir(distDir, { recursive: true })

for (const name of sourceFiles) {
  const sourcePath = path.join(srcDir, name)
  const code = await readFile(sourcePath, "utf8")
  // The same call the host's Bun plugin makes at load time: babel-preset-solid
  // (universal, module "@opentui/solid") plus the TypeScript preset for .ts.
  const out = await transformSolidSource(code, {
    filename: sourcePath,
    resolvePath,
  })
  const target = path.join(distDir, name.replace(/\.(tsx?|jsx)$/, ".js"))
  await writeFile(target, out)
  process.stdout.write(`  dist/${path.basename(target)}  ${Buffer.byteLength(out)} B\n`)
}

process.stdout.write(`built ${sourceFiles.length} files -> dist/\n`)
