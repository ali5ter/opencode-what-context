#!/usr/bin/env bun
/**
 * layout-probe.ts — compute the what-context panel's flex layout with
 * opentui's own yoga engine, reproducing the real OpenCode 2.3.2 host chain
 * (app column → session-view row → content pane → session-panel slot box)
 * around the panel's box tree. Pure layout math — no renderer, no TTY — so it
 * answers definitively what height each element gets at a given terminal
 * size. Current model: a fill-and-shrink root with a fixed header row and a
 * single whole-panel scrollbox (basis 0) carrying the three boxes at their
 * natural heights.
 *
 * Usage: bun scripts/layout-probe.ts [width] [height] [pane-width] [content-rows]
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { Node, FlexDirection, Align, Edge, Gutter, Overflow, BoxSizing, type MeasureFunction } from "../node_modules/@opentui/core/yoga.js"

const width = Number(process.argv[2] ?? 60)
const height = Number(process.argv[3] ?? 30)
const paneWidth = Number(process.argv[4] ?? Math.max(20, Math.floor(width / 2) + 1))
const contentRows = Number(process.argv[5] ?? 29)

type Spec = {
  label: string
  dir?: FlexDirection
  grow?: number
  shrink?: number
  basis?: number | null // null = auto
  width?: number | "auto" | `${number}%`
  height?: number | "auto" | `${number}%`
  minWidth?: number
  minHeight?: number
  pad?: number[] // [left, top, right, bottom]
  gap?: number
  align?: Align
  overflow?: Overflow
  border?: boolean
  measure?: (w: number) => number // text: height in rows at a given width
}

function make(spec: Spec): Node {
  const node = Node.create()
  node.setBoxSizing(BoxSizing.BorderBox)
  if (spec.dir !== undefined) node.setFlexDirection(spec.dir)
  if (spec.align !== undefined) node.setAlignItems(spec.align)
  if (spec.grow !== undefined) node.setFlexGrow(spec.grow)
  if (spec.shrink !== undefined) node.setFlexShrink(spec.shrink)
  if (spec.basis !== null) {
    if (spec.basis === undefined) node.setFlexBasisAuto()
    else node.setFlexBasis(spec.basis)
  } else node.setFlexBasisAuto()
  const setDim = (dim: "w" | "h", v: number | "auto" | `${number}%` | undefined) => {
    if (v === undefined) return
    if (v === "auto") return dim === "w" ? node.setWidthAuto() : node.setHeightAuto()
    if (typeof v === "string")
      return dim === "w" ? node.setWidthPercent(Number(v.slice(0, -1))) : node.setHeightPercent(Number(v.slice(0, -1)))
    return dim === "w" ? node.setWidth(v) : node.setHeight(v)
  }
  setDim("w", spec.width)
  setDim("h", spec.height)
  if (spec.minWidth !== undefined) node.setMinWidth(spec.minWidth)
  if (spec.minHeight !== undefined) node.setMinHeight(spec.minHeight)
  if (spec.border) {
    node.setBorder(Edge.Left, 1)
    node.setBorder(Edge.Right, 1)
    node.setBorder(Edge.Top, 1)
    node.setBorder(Edge.Bottom, 1)
  }
  if (spec.pad) {
    const edges = [Edge.Left, Edge.Top, Edge.Right, Edge.Bottom] as const
    spec.pad.forEach((p, i) => node.setPadding(edges[i], p))
  }
  if (spec.gap !== undefined) node.setGap(Gutter.All, spec.gap)
  if (spec.overflow !== undefined) node.setOverflow(spec.overflow)
  if (spec.measure !== undefined) {
    const fn: MeasureFunction = (w, _wm, _h, _hm) => ({
      width: w > 0 ? w : 40,
      height: spec.measure!(w),
    })
    node.setMeasureFunc(fn)
  }
  ;(node as unknown as { spec: Spec }).spec = spec
  return node
}

function parent(child: Node, ...kids: Node[]) {
  kids.forEach((k, i) => child.insertChild(k, i))
  return child
}

const C = FlexDirection.Column
const R = FlexDirection.Row

// One text row (a legend/detail line in the context box).
const row = (label: string) => make({ label, measure: () => 1, width: "auto", height: "auto" })

// --- The app: terminal is a column of [session view, prompt] ---------------
const prompt = make({ label: "prompt", dir: C, width: "100%", height: 8, shrink: 0, border: true })
const promptText = row("prompt text")
parent(prompt, promptText)

const sessionView = make({ label: "et (session view, row)", dir: R, grow: 1, minWidth: 0, minHeight: 0 })

// session-pane (the host sidebar: terminal picker etc.) — not our concern.
const sessionPane = make({ label: "Tt (session-pane)", dir: C, grow: 1, basis: 0, minWidth: 0, minHeight: 0, height: "100%" })
parent(sessionView, sessionPane)

// je: the content pane that hosts the session.panel slot.
const je = make({ label: "je (content pane)", dir: C, shrink: 0, minWidth: 0, minHeight: 0, width: paneWidth })

// p: the host's session-panel box (flexGrow 1, focusable).
const p = make({ label: "p (session-panel)", dir: C, grow: 1, minWidth: 0, minHeight: 0 })
parent(je, p)
parent(sessionView, je)

// --- Our plugin content: fill-and-shrink root, fixed header, whole-panel
// scrollbox carrying the three boxes at their natural heights.
const top = make({ label: "top (ours, fill+shrink)", dir: C, width: "100%", grow: 1, shrink: 1, minWidth: 0, minHeight: 0, gap: 1, pad: [1, 1, 1, 1] })
parent(p, top)

const header = make({ label: "header (name + version)", measure: () => 1, shrink: 0, width: "auto", minWidth: 0, minHeight: 0 })
parent(top, header)

// The whole-panel scrollbox (basis 0): it takes the space the slot leaves
// below the header; its content column is the boxes' combined natural height.
const bodyScroll = make({ label: "panel scrollbox", dir: C, grow: 1, shrink: 1, basis: 0, width: "100%", minHeight: 0, minWidth: 0, overflow: Overflow.Hidden })
const bodyCol = make({ label: "body column (natural)", dir: C, width: "100%", minWidth: 0, gap: 0 })
parent(bodyScroll, bodyCol)
parent(top, bodyScroll)

// Context box: content-sized (no explicit height).
const ctxContent = make({ label: "ctx detail content", dir: C, minWidth: 0, shrink: 0 })
for (let i = 0; i < contentRows; i++) parent(ctxContent, row(`row ${i}`))
const ctx = make({ label: "context box", dir: C, width: "100%", shrink: 0, minWidth: 0, pad: [1, 0, 1, 0], border: true })
parent(ctx, ctxContent)

const trend = make({ label: "trend box", dir: C, width: "100%", grow: 0, shrink: 0, minWidth: 0, pad: [1, 0, 1, 0], border: true })
parent(trend, row("bars"), row("caret"))

// Requests box: header row plus the full natural list (no inner scroll).
const reqContent = make({ label: "req list content", dir: C, minWidth: 0, shrink: 0 })
for (let i = 0; i < 200; i++) parent(reqContent, row(`call ${i}`))
const reqInner = make({ label: "req inner (natural)", dir: C, width: "100%", minWidth: 0 })
parent(reqInner, row("header"), reqContent)
const req = make({ label: "requests box", dir: C, width: "100%", shrink: 0, minWidth: 0, pad: [1, 0, 1, 0], border: true })
parent(req, reqInner)

parent(bodyCol, ctx, trend, req)
const footer = make({ label: "footer (key help)", dir: R, width: "100%", height: 1, shrink: 0, minWidth: 0, minHeight: 0 })
parent(top, footer)

const app = make({ label: "app root", dir: C, width, height, minWidth: 0, minHeight: 0 })
parent(app, sessionView, prompt)
app.calculateLayout(width, height)

// --- Report ------------------------------------------------------------------
function walk(node: Node, depth: number) {
  const spec = (node as unknown as { spec?: Spec }).spec
  const w = node.getComputedWidth()
  const h = node.getComputedHeight()
  console.log(`${"  ".repeat(depth)}${spec?.label ?? "?"}: ${w.toFixed(1)} x ${h.toFixed(1)}`)
  for (let i = 0; i < node.getChildCount(); i++) walk(node.getChild(i)!, depth + 1)
}
walk(app, 0)
console.log("\nprompt top:", prompt.getComputedTop(), "et top:", sessionView.getComputedTop(), "et base-ish:", sessionView.getFlexGrow())

// The verdict: the whole-panel scrollbox's allotted height vs. the content's
// natural height.
const scrollH = bodyScroll.getComputedHeight()
const naturalH = bodyCol.getComputedHeight()
console.log(`\nVERDICT: panel scrollbox gets ${scrollH.toFixed(1)} rows; content wants ${naturalH.toFixed(1)} rows (ctx ${contentRows} + trend + 200-record list)`)
console.log(naturalH > scrollH ? "  → content CLIPS (the panel scrolls)" : "  → content fits (no scroll needed)")
app.freeRecursive()
process.exit(0)
