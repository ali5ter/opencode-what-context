#!/usr/bin/env bun
/**
 * context-preview.ts — render the context box model in a real terminal.
 *
 * Feeds the pure context-box model (`src/context.ts`) five sample records —
 * one per display state (happy, awaiting, orphan, error, title) — and prints
 * the box exactly as the TUI composes it: the window grid, the figure line,
 * the composition legend with the system breakdown, the response line, and
 * the unit footer, in truecolor.
 *
 * The sample data mirrors the design mock (`context-usage-v3.py`): a 200k
 * window, a 112k prompt (73% cache-read), a 20k auto-compact reserve.
 *
 * Usage: bun scripts/context-preview.ts
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { RGBA } from "@opentui/core"
import type { ResolvedTheme } from "@opencode/theme/tui"
import { contextDetail, type DetailSpan } from "../src/context"
import type { CallView, CompositionShape } from "../src/types"

// --- a dark terminal theme (the tokens the model reads) -------------------

// The built-in default theme, dark mode, as resolved from the opencode binary:
// accent = purple, interactive = orange, neutral = gray. Note that in this
// theme text.muted *is* hue.neutral.400 — the same token the tools slice uses
// — and text.faint defaults back to muted, so muted and faint resolve to one
// gray. The categorical palette is the theme's set of distinct hues; the
// scaffolding slice picks the one furthest from the house hues (here: blue).
const theme = {
  hue: {
    accent: { 400: RGBA.fromInts(0x73, 0x57, 0xa2) }, // purple
    interactive: { 400: RGBA.fromInts(0xb6, 0x7c, 0x56) }, // orange
    neutral: { 400: RGBA.fromInts(0x80, 0x80, 0x80) }, // gray
  },
  categorical: [
    { 400: RGBA.fromInts(0x3c, 0x70, 0xb8) }, // blue
    { 400: RGBA.fromInts(0x73, 0x57, 0xa2) }, // purple
    { 400: RGBA.fromInts(0x53, 0x9c, 0x61) }, // green
    { 400: RGBA.fromInts(0xb6, 0x7c, 0x56) }, // orange
    { 400: RGBA.fromInts(0xa7, 0x49, 0x52) }, // red
  ],
  text: {
    base: RGBA.fromInts(0xee, 0xee, 0xee), // neutral.200
    muted: RGBA.fromInts(0x80, 0x80, 0x80), // neutral.400
    faint: RGBA.fromInts(0x80, 0x80, 0x80), // defaults to muted
    feedback: {
      error: { base: RGBA.fromInts(0xe0, 0x6c, 0x75), muted: RGBA.fromInts(0xa7, 0x49, 0x52) }, // red.200 / red.400
      warning: { base: RGBA.fromInts(0xf5, 0xa7, 0x42), muted: RGBA.fromInts(0xb6, 0x7c, 0x56) }, // #f5a742 / orange.400
    },
  },
} as unknown as ResolvedTheme

// --- sample records (the mock's figures, as captured records) --------------

const SESSION = "ses_sample"
const MODEL = { providerID: "lmstudio", id: "qwen3.8-27b-splash" }

/** The shared composition: rendered bytes proportioned to the mock's slices. */
function composition(systemRendered: number): CompositionShape {
  const sources = [
    { key: "core/skill-guidance", bytes: 4000, rendered: Math.round(systemRendered * 0.42), sample: null },
    { key: "core/instructions", bytes: 3500, rendered: Math.round(systemRendered * 0.34), sample: null },
    { key: "core/rules", bytes: 3200, rendered: systemRendered - Math.round(systemRendered * 0.42) - Math.round(systemRendered * 0.34), sample: null },
  ]
  return {
    system: [{ bytes: 10700, rendered: systemRendered, sample: null, sources }],
    messages: [
      {
        role: "user",
        parts: [
          { type: "text", bytes: 56_000, rendered: 56_000, sample: null },
          { type: "text", bytes: 12_000, rendered: 12_000, sample: null },
        ],
      },
      {
        role: "assistant",
        parts: [
          { type: "reasoning", bytes: 2_000, rendered: 2_000, sample: null },
          { type: "tool", bytes: 8_000, rendered: 8_000, sample: null, tool: "read" },
          { type: "tool", bytes: 2_400, rendered: 2_400, sample: null, tool: "grep" },
        ],
      },
    ],
    tools: [],
    totals: {
      systemBytes: 10_700,
      systemRendered,
      contentBytes: 80_400,
      contentRendered: 80_400,
      toolsBytes: 7_100,
      toolsRendered: 7_100,
    },
  }
}

function record(seq: number, patch: Partial<CallView> = {}): CallView {
  return {
    v: 2,
    full: false,
    sessionID: SESSION,
    agent: "main",
    model: MODEL,
    request: { time: `t${seq}`, url: "http://sample/v1", method: "POST", bodyBytes: 100_000 },
    composition: composition(10_700),
    overhead: { bodyBytes: 100_000, compositionRendered: 98_200, delta: 1_800 },
    response: { time: `t${seq}+1`, status: 200, usage: null },
    tokens: null,
    seq,
    ...patch,
  } as CallView
}

// happy: usage landed — the mock's figures (112k prompt, 73% cache, 1.2k response).
const happy = record(1, {
  kind: "primary",
  request: { ...record(1, {}).request, bodyBytes: 100_000 },
  tokens: { input: 30_240, output: 900, reasoning: 300, cache: { read: 81_760, write: 0 } },
  response: { time: "t1+1", status: 200, usage: { prompt_tokens: 112_000, completion_tokens: 1_200 } },
})

// awaiting: a bigger follow-up request, in flight (the shape state's baseline is `happy`).
const awaiting = record(2, {
  kind: "primary",
  request: { ...record(2, {}).request, bodyBytes: 118_000 },
  overhead: { ...record(2, {}).overhead, bodyBytes: 118_000 },
  response: null,
})

const orphan = record(3, {
  kind: "primary",
  request: { ...record(3, {}).request, bodyBytes: 118_000 },
  response: null,
  orphan: true,
})

const error = record(4, {
  kind: "primary",
  request: { ...record(4, {}).request, bodyBytes: 118_000 },
  response: { time: "t4+1", status: 500, usage: null },
  tokens: null,
})

// title: a non-primary call (no composition), small prompt and response.
const title = record(5, {
  kind: "title",
  composition: null,
  tokens: { input: 11_900, output: 61, reasoning: 0, cache: { read: 100, write: 0 } },
  response: { time: "t5+1", status: 200, usage: { prompt_tokens: 12_000, completion_tokens: 61 } },
})

// --- ANSI rendering (a faithful stand-in for the terminal) ------------------

const RESET = "\x1b[0m"
const BOLD = "\x1b[1m"

function paint(color: RGBA, text: string, bold: boolean): string {
  const [r, g, b] = color.toInts()
  return `\x1b[38;2;${r};${g};${b}m${bold ? BOLD : ""}${text}${RESET}`
}

function spanColor(span: DetailSpan, th: ResolvedTheme): RGBA {
  if (span.level === "base") return th.text.base
  if (span.level === "muted") return th.text.muted
  if (span.level === "faint") return th.text.faint
  if (span.severity === "error") return th.text.feedback.error.base
  if (span.severity === "warning") return th.text.feedback.warning.base
  return th.text.muted
}

/** The box's content width (the mock's 60-column box, inner 56). */
const INNER = 56
const MODEL_LABEL = `${MODEL.providerID}/${MODEL.id}`

function renderBox(label: string): void {
  const records = { happy, awaiting, orphan, error, title } as Record<string, CallView>
  const rec = records[label] ?? happy
  const history = [happy, rec].filter((r, i, all) => all.indexOf(r) === i)
  const d = contextDetail(rec, history, 200_000, true, 20_000, INNER, theme)

  const lines: string[] = []
  const push = (ansi: string) => lines.push(ansi)

  push(paint(theme.text.base, "Usage:", false))
  for (const runs of d.rows) {
    push(
      runs
        .map((run, i) => (i > 0 ? " " : "") + paint(run.fg, run.text, false))
        .join(""),
    )
  }
  push(d.figure.map((s) => paint(spanColor(s, theme), s.text, s.bold === true)).join(""))
  push("")
  push(paint(theme.text.base, "Composition:", false))
  if (d.legend.length === 0) {
    push(paint(theme.text.muted, "no composition captured", false))
  } else {
    d.legend.forEach((row, i) => {
      push(
        paint(row.fg, row.glyph, false) +
          ` ` +
          paint(theme.text.muted, row.name, false) +
          paint(theme.text.faint, row.leader, false) +
          ` ` +
          paint(theme.text.base, row.value.padStart(6), false) +
          (row.pct !== null ? ` ` + paint(theme.text.muted, row.pct, false) : ""),
      )
      // Legend order: system, messages, tools, scaffolding, free, buffer. Only
      // the first two have breakdowns, hung beneath their own row.
      const subs = i === 0 ? d.subs.system : i === 1 ? d.subs.messages : []
      for (const sub of subs) {
        push(
          paint(theme.text.faint, sub.tree, false) +
            paint(theme.text.muted, sub.name, false) +
            paint(theme.text.faint, sub.leader, false) +
            ` ` +
            paint(theme.text.base, sub.value.padStart(6), false) +
            (sub.pct !== null ? ` ` + paint(theme.text.muted, sub.pct, false) : ""),
        )
      }
    })
  }
  push("")
  push(paint(theme.text.base, "Response:", false))
  if (d.response !== null) {
    push(d.response.map((s) => paint(spanColor(s, theme), s.text, s.bold === true)).join(""))
  }
  if (d.footer !== null) {
    push("")
    push(paint(theme.text.faint, d.footer, false))
  }

  // The box: rounded border, the model on the title, content padded to INNER.
  const width = INNER + 4 // border + padding each side
  const boxTitle = `Context · ${MODEL_LABEL}`
  // The real box (opentui) embeds the title in the top border and continues
  // the border line after it, so the fill is dashes, not spaces.
  const top = "╭─ " + boxTitle + " " + "─".repeat(Math.max(0, width - 5 - boxTitle.length)) + "╮"
  console.log(top)
  for (const l of lines) {
    const plain = l.replace(/\x1b\[[0-9;]*m/g, "")
    const pad = Math.max(0, INNER - [...plain].length)
    console.log(`│ ${l}${" ".repeat(pad)} │`)
  }
  console.log(`╰${"─".repeat(width - 2)}╯`)
}

for (const label of ["happy", "awaiting", "orphan", "error", "title"]) {
  console.log(`\n── state: ${label} ──\n`)
  renderBox(label)
}
