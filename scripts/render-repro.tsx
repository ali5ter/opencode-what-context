#!/usr/bin/env bun
/**
 * render-repro.tsx — render the live panel's context box in a real opentui
 * test renderer: the exact tree (root → scrollbox → column → bordered box →
 * rows), the real `contextDetail` model, and the character frame dumped at
 * several outer widths. The regression this guards: a row wider than the
 * box's inner width makes the engine truncate it with a `...` marker — the
 * narrow-panel dots. A clean frame (no `...`) at every width is the pass.
 *
 * Usage: bun scripts/render-repro.tsx [outer-width ...]
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { testRender } from "@opentui/solid"
import { RGBA } from "@opentui/core"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { contextDetail } from "../src/context"
import type { CallView } from "../src/types"

// The built-in default theme, dark mode (same stand-in as context-preview).
const theme = {
  hue: {
    accent: { 400: RGBA.fromInts(0x73, 0x57, 0xa2) },
    interactive: { 400: RGBA.fromInts(0xb6, 0x7c, 0x56) },
    neutral: { 400: RGBA.fromInts(0x80, 0x80, 0x80) },
  },
  categorical: [
    { 400: RGBA.fromInts(0x3c, 0x70, 0xb8) },
    { 400: RGBA.fromInts(0x73, 0x57, 0xa2) },
    { 400: RGBA.fromInts(0x53, 0x9c, 0x61) },
    { 400: RGBA.fromInts(0xb6, 0x7c, 0x56) },
    { 400: RGBA.fromInts(0xa7, 0x49, 0x52) },
  ],
  text: {
    base: RGBA.fromInts(0xee, 0xee, 0xee),
    muted: RGBA.fromInts(0x80, 0x80, 0x80),
    faint: RGBA.fromInts(0x80, 0x80, 0x80),
    feedback: {
      error: { base: RGBA.fromInts(0xe0, 0x6c, 0x75), muted: RGBA.fromInts(0xa7, 0x49, 0x52) },
      warning: { base: RGBA.fromInts(0xf5, 0xa7, 0x42), muted: RGBA.fromInts(0xb6, 0x7c, 0x56) },
    },
  },
} as unknown as ResolvedTheme

// A happy record with a full composition (the preview's sample, abridged).
const happy = {
  v: 2,
  full: false,
  kind: "primary",
  sessionID: "ses_sample",
  agent: "main",
  model: { providerID: "lmstudio", id: "qwen3.8-27b-splash" },
  request: { time: "t1", url: "http://sample/v1", method: "POST", bodyBytes: 100_000 },
  composition: {
    system: [
      {
        bytes: 10_700,
        rendered: 10_700,
        sample: null,
        sources: [
          { key: "core/skill-guidance", bytes: 4000, rendered: 4_500, sample: null },
          { key: "core/instructions", bytes: 3500, rendered: 3_700, sample: null },
          { key: "core/rules", bytes: 3200, rendered: 2_500, sample: null },
        ],
      },
    ],
    messages: [
      { role: "user", parts: [{ type: "text", bytes: 56_000, rendered: 56_000, sample: null }] },
      { role: "assistant", parts: [{ type: "reasoning", bytes: 2_000, rendered: 2_000, sample: null }] },
    ],
    tools: [],
    totals: { systemBytes: 10_700, systemRendered: 10_700, contentBytes: 58_000, contentRendered: 58_000, toolsBytes: 7_100, toolsRendered: 7_100 },
  },
  overhead: { bodyBytes: 100_000, compositionRendered: 98_200, delta: 1_800 },
  response: { time: "t1+1", status: 200, usage: { prompt_tokens: 75_800, completion_tokens: 1_200 } },
  tokens: { input: 30_240, output: 900, reasoning: 300, cache: { read: 81_760, write: 0 } },
  seq: 1,
} as unknown as CallView

function App({ d }: { d: ReturnType<typeof contextDetail> }) {
  return (
    <box width="100%" height="100%" flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1} gap={1}>
      <scrollbox scrollY flexGrow={1} flexShrink={1} flexBasis={0} width="100%" minHeight={0} minWidth={0}>
        <box flexDirection="column" width="100%" minWidth={0} gap={0}>
          <box
            border
            borderStyle="rounded"
            title={`Context · ${happy.model.providerID}/${happy.model.id}`}
            paddingLeft={1}
            paddingRight={1}
            minWidth={0}
          >
            <box flexDirection="column" width="100%" minWidth={0}>
              <text fg={theme.text.base} wrapMode="none" truncate selectable={false}>
                {`Composition:`}
              </text>
              {d.legend.map((row, i) => (
                <>
                  <text wrapMode="none" truncate selectable={false}>
                    <span style={{ fg: row.fg }}>{row.glyph}</span>
                    <span style={{ fg: theme.text.muted }}>{` ${row.name}`}</span>
                    <span style={{ fg: theme.text.faint }}>{row.leader}</span>
                    <span style={{ fg: theme.text.base }}>{` ${row.value.padStart(6)}`}</span>
                    {row.pct !== null && <span style={{ fg: theme.text.muted }}>{` ${row.pct}`}</span>}
                  </text>
                  {(i === 0 ? d.subs.system : i === 1 ? d.subs.messages : []).map((sub) => (
                    <text wrapMode="none" truncate selectable={false}>
                      <span style={{ fg: theme.text.faint }}>{sub.tree}</span>
                      <span style={{ fg: theme.text.muted }}>{sub.name}</span>
                      <span style={{ fg: theme.text.faint }}>{sub.leader}</span>
                      <span style={{ fg: theme.text.base }}>{` ${sub.value.padStart(6)}`}</span>
                      {sub.pct !== null && <span style={{ fg: theme.text.muted }}>{` ${sub.pct}`}</span>}
                    </text>
                  ))}
                </>
              ))}
            </box>
          </box>
        </box>
      </scrollbox>
    </box>
  )
}

const args = process.argv.slice(2).map(Number)
const widths =
  args.length > 0 && args.every((n) => Number.isFinite(n) && n > 0)
    ? args
    : [34, 36, 38, 40, 45, 50, 56, 62, 70]

// Visualise cells: U+0A00 (empty) -> '.', space -> '_', else the character.
const vis = (c: string | undefined): string => (c === "\u0a00" ? "." : c === " " ? "_" : c ?? "?")

let failures = 0
for (const W of widths) {
  const inner = Math.max(0, W - 2 - 4) // the tui's innerWidth formula
  const d = contextDetail(happy, [happy], 262_100, true, 20_000, inner, theme)
  const setup = await testRender(() => <App d={d} />, { width: W, height: 16 })
  await setup.flush()
  const frame = setup.captureCharFrame()
  // The character frame is a string of *variable-length* lines (trailing
  // empty cells are omitted), so read it line-wise, never as a flat buffer.
  const lines = (frame as string).split("\n")
  const truncated = lines.some((l) => l.includes("..."))
  const wrapped = lines.some((l) => l.length > W)
  if (truncated || wrapped) failures++
  console.log(`\n=== outer ${W} (inner ${inner}) ${truncated || wrapped ? "ARTIFACT" : "ok"} ===`)
  for (const raw of lines) {
    if (raw.length === 0) continue
    const line = Array.from(raw).map(vis).join("")
    if (line.includes("·") || line.includes("...") || line.includes("╮") || line.includes("Composition") || line.includes("System")) {
      console.log(`${line} (${raw.length} cols)`)
    }
  }
  await setup.dispose()
}
console.log(failures === 0 ? "\nall widths clean" : `\n${failures} width(s) truncated`)
process.exit(failures === 0 ? 0 : 1)
