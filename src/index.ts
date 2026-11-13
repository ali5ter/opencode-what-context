/**
 * opencode-what-context — build step 2: per-call records.
 *
 * Joins the three session hooks into one record per model call, stored at
 * `wc/call/<sessionID>/<seq>` in plugin storage:
 *
 * - `context` (primary calls only) supplies the composition: per-source system parts,
 *   per-part messages, and per-tool schema sizes, each with raw UTF-8 bytes and
 *   JSON-rendered bytes (the bytes the wire body spends on that part).
 * - `http.request` supplies the wire body size (overhead cross-check) and consumes the
 *   pending composition. Pairing is by session plus fire-time ordering — a pending
 *   composition queue per session, consumed by the next `primary` request — never by
 *   per-hook sequence numbers (which drift when title/compaction calls fire).
 * - `http.response` supplies provider-reported usage, normalized to the DB token shape
 *   `{input, output, reasoning, cache: {read, write}}`.
 *
 * Build step 3 adds the presentation seam: the records are served to the TUI
 * part (`tui.tsx`) over the `what-context` RPC (`rpc.ts`) and each write is
 * announced with a `recorded` event so an open panel stays live.
 *
 * Pairing detail: the response event carries the same `Request` object the request
 * event received, so the response is matched to its in-flight record by object
 * identity, with per-kind FIFO as fallback.
 *
 * Redaction policy: conversation content is reduced to byte counts with a short
 * sample per part. Full texts (and the full wire body) are persisted only when the
 * `WC_FULL=1` environment variable is set — an explicit research mode for measuring
 * per-part token ground truth; delete those records after measuring.
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { Plugin } from "@opencode/plugin"
import type { StorageEntry } from "@opencode/plugin"
import type {
  SessionContext,
  SessionHttpRequest,
  SessionHttpResponse,
} from "@opencode/plugin/promise/session"
import { WhatContext } from "./rpc"
import type {
  CallRecord,
  CallView,
  CompositionShape,
  MessageShape,
  PartShape,
  SourceShape,
  SystemShape,
  TokensShape,
  ToolShape,
  UsageShape,
} from "./types"

/** The plugin storage value type. */
type Json = StorageEntry["value"]

/** Strings longer than this get a sample; shorter strings may be kept verbatim in FULL mode. */
const SAMPLE = 48

/** Pending compositions older than this are dropped as stale (the request never dispatched). */
const STALE_MS = 60_000

/** In-flight requests older than this are marked orphan (no response arrived). */
const ORPHAN_MS = 120_000

/** The runtime's environment variables, without requiring Node type definitions. */
const env: Record<string, string | undefined> =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}

/** Research mode: persist full texts and the wire body. Off by default. */
const FULL = env["WC_FULL"] === "1"

const encoder = new TextEncoder()

/**
 * Byte length of a UTF-8 string.
 *
 * @param text - The string to measure.
 * @returns The number of UTF-8 bytes.
 */
function utf8(text: string): number {
  return encoder.encode(text).length
}

/**
 * JSON-rendered byte length: the bytes this value occupies inside a JSON body,
 * i.e. the UTF-8 length of its JSON serialization (strings include the quotes).
 *
 * @param value - The value to measure.
 * @returns The number of UTF-8 bytes of the JSON serialization.
 */
function rendered(value: unknown): number {
  try {
    return utf8(JSON.stringify(value) ?? "null")
  } catch {
    return -1
  }
}

/**
 * Coerce a value to a string, treating non-strings as empty.
 *
 * @param value - The value to coerce.
 * @returns The value when it is a string, otherwise the empty string.
 */
function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/**
 * Short sample of a string, for identifying parts without persisting their content.
 *
 * @param text - The string to sample.
 * @returns Up to `SAMPLE` leading characters, or null for empty strings.
 */
function sample(text: string): string | null {
  return text.length === 0 ? null : text.slice(0, SAMPLE)
}

/**
 * Build the composition snapshot from a `context` event.
 *
 * @param event - The context event as fired by OpenCode.
 * @returns The per-part composition with raw and JSON-rendered byte counts.
 */
function composeSystemPart(part: unknown): SystemShape {
  const p = part as Record<string, unknown>
  const text = str(p["text"])
  const out: SystemShape = { bytes: utf8(text), rendered: rendered(text), sample: sample(text) }
  if (FULL) out.text = text
  const experimental = (p["metadata"] ?? {}) as {
    experimental?: { instructions?: Array<{ key: string; text: string }> }
  }
  const sources = experimental.experimental?.instructions
  if (Array.isArray(sources)) {
    out.sources = sources.map((source) => {
      const shape: SourceShape = {
        key: str(source.key),
        bytes: utf8(source.text),
        rendered: rendered(source.text),
        sample: sample(source.text),
      }
      if (FULL) shape.text = source.text
      return shape
    })
  }
  return out
}

/**
 * Describe one message content part.
 *
 * @param part - The content part as fired by OpenCode.
 * @returns The part's type with raw and JSON-rendered byte counts.
 */
function composePart(part: unknown): PartShape {
  const p = part as Record<string, unknown>
  const type = str(p["type"])
  let bytes = 0
  let renderedBytes = 0
  let sampleText: string | null = null
  let text: string | null = null
  let tool: string | null = null
  switch (type) {
    case "text":
    case "reasoning":
    case "compaction": {
      text = str(p["text"])
      bytes = utf8(text)
      renderedBytes = rendered(text)
      sampleText = sample(text)
      break
    }
    case "tool-call": {
      tool = str(p["name"]) || null
      const input = p["input"]
      bytes = rendered(input ?? null)
      renderedBytes = bytes
      break
    }
    case "tool-result": {
      tool = str(p["name"]) || null
      const result = (p["result"] ?? {}) as Record<string, unknown>
      bytes = rendered(result["value"] ?? null)
      renderedBytes = bytes
      break
    }
    case "media": {
      const media = p["media"] as
        | { source?: { type?: string; data?: Uint8Array | string; url?: string } }
        | undefined
      const source = media?.source
      if (source?.type === "base64" && typeof source.data === "string") {
        bytes = source.data.length
        renderedBytes = rendered(source.data)
      } else if (source?.type === "bytes" && source.data instanceof Uint8Array) {
        bytes = source.data.length
        renderedBytes = bytes
      } else if (source?.type === "url" && typeof source.url === "string") {
        bytes = utf8(source.url)
        renderedBytes = rendered(source.url)
      } else {
        bytes = -1
        renderedBytes = -1
      }
      break
    }
    default: {
      // Unknown part type (e.g. `effort`): measure the whole serialized part so
      // nothing is silently unaccounted for.
      bytes = rendered(p)
      renderedBytes = bytes
    }
  }
  const out: PartShape = { type: type || "unknown", bytes, rendered: renderedBytes, sample: sampleText }
  if (tool) out.tool = tool
  if (FULL && text !== null) out.text = text
  return out
}

/**
 * Build the per-message shapes.
 *
 * @param messages - The messages array as fired by OpenCode.
 * @returns One shape per message, with one shape per content part.
 */
function composeMessages(messages: unknown): MessageShape[] {
  if (!Array.isArray(messages)) return []
  return messages.map((raw) => {
    const m = raw as Record<string, unknown>
    const content = Array.isArray(m["content"]) ? m["content"] : []
    return {
      role: str(m["role"]) || "unknown",
      parts: content.map(composePart),
    }
  })
}

/**
 * Build the per-tool shapes.
 *
 * @param tools - The tools record as fired by OpenCode.
 * @returns One shape per tool: description and schema sizes.
 */
function composeTools(tools: Record<string, { description: string; input: unknown }>): ToolShape[] {
  return Object.entries(tools).map(([name, tool]) => {
    const description = tool.description ?? ""
    const schema = tool.input ?? null
    const out: ToolShape = {
      name,
      descBytes: utf8(description),
      descRendered: rendered(description),
      schemaBytes: rendered(schema),
      schemaRendered: rendered(schema),
    }
    if (FULL) {
      out.description = description
      out.schema = schema
    }
    return out
  })
}

/**
 * Build the full composition snapshot for a `context` event.
 *
 * @param event - The context event as fired by OpenCode.
 * @returns The composition with per-part byte counts and totals.
 */
function compose(event: SessionContext): CompositionShape {
  const system = event.system.map(composeSystemPart)
  const messages = composeMessages(event.messages)
  const tools = composeTools(event.tools)
  const sum = (values: number[]): number => values.reduce((a, b) => a + (b > 0 ? b : 0), 0)
  const contentBytes = sum(messages.flatMap((m) => m.parts.map((p) => p.bytes)))
  const contentRendered = sum(messages.flatMap((m) => m.parts.map((p) => p.rendered)))
  return {
    system,
    messages,
    tools,
    totals: {
      systemBytes: sum(system.map((s) => s.bytes)),
      systemRendered: sum(system.map((s) => s.rendered)),
      contentBytes,
      contentRendered,
      toolsBytes: sum(tools.map((t) => t.descBytes + t.schemaBytes)),
      toolsRendered: sum(tools.map((t) => t.descRendered + t.schemaRendered + utf8(t.name))),
    },
  }
}

/**
 * Normalize provider-reported usage to the DB token shape.
 *
 * When the provider reports `prompt_tokens_details.cached_tokens` (ollama /
 * Anthropic-style), `input` is the uncached remainder and `cache.read` the cached
 * prefix; otherwise `input` is the full prompt (lmstudio / plain OpenAI-style,
 * `cache.read` 0). `reasoning` is the provider's reasoning count and `output` the
 * non-reasoning remainder of `completion_tokens` — matching the DB row, which
 * stores them split (verified: DB output + reasoning == provider completion).
 *
 * @param usage - The raw usage object from the final response frame.
 * @returns The normalized token figures, or null when usage is absent.
 */
function normalizeTokens(usage: UsageShape | null): TokensShape | null {
  if (usage === null || typeof usage !== "object") return null
  const prompt = typeof usage["prompt_tokens"] === "number" ? usage["prompt_tokens"] : null
  const completion =
    typeof usage["completion_tokens"] === "number" ? usage["completion_tokens"] : null
  if (prompt === null) return null
  const details = (usage["prompt_tokens_details"] ?? {}) as Record<string, unknown>
  const cached = typeof details["cached_tokens"] === "number" ? details["cached_tokens"] : 0
  const write =
    typeof details["cache_creation_tokens"] === "number" ? details["cache_creation_tokens"] : 0
  const compDetails = (usage["completion_tokens_details"] ?? {}) as Record<string, unknown>
  const reasoning = typeof compDetails["reasoning_tokens"] === "number" ? compDetails["reasoning_tokens"] : 0
  return {
    input: cached > 0 ? prompt - cached : prompt,
    output: (completion ?? 0) - reasoning,
    reasoning,
    cache: { read: cached, write },
  }
}

/**
 * Extract provider-reported usage from a response body.
 *
 * @param text - The full response body text, read from a clone.
 * @param contentType - The body's content type, if any.
 * @returns The last usage object found in the body, or null.
 */
function extractUsage(text: string, contentType: string | null): UsageShape | null {
  if (contentType !== null && contentType.includes("json")) {
    try {
      const body = JSON.parse(text) as { usage?: unknown }
      return body.usage !== undefined ? (body.usage as UsageShape) : null
    } catch {
      return null
    }
  }
  if (contentType === null || contentType.includes("event-stream") || text.startsWith("data:")) {
    let last: UsageShape | null = null
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") continue
      try {
        const frame = JSON.parse(payload) as { usage?: unknown }
        if (frame.usage !== undefined) last = frame.usage as UsageShape
      } catch {
        // Keepalive or non-JSON frame: nothing to record.
      }
    }
    return last
  }
  return null
}

/** One queued composition awaiting its `primary` request. */
interface Pending {
  time: number
  composition: CompositionShape
}

/** One in-flight request awaiting its response. */
interface InFlight {
  request: Request
  key: string
  seq: number
  kind: string
  time: number
}

export default Plugin.define({
  id: "opencode-what-context",
  async setup(ctx) {
    console.log(`[what-context] v3 loaded in OpenCode ${ctx.app.version} (full=${FULL})`)

    // Serve the captured records to the TUI over RPC and announce each write so
    // an open panel refetches. The TUI part cannot read this storage directly
    // (different process, different backend); the bridge is `rpc.ts`.
    const rpc = await ctx.rpc.register(WhatContext, {
      calls: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const prefix = `wc/call/${sessionID}/`
        const scan = await ctx.storage.scan({ prefix, limit: 10_000 })
        const views: CallView[] = scan.entries.map((entry) => ({
          ...(entry.value as unknown as CallRecord),
          seq: Number(entry.key.slice(prefix.length)),
        }))
        views.sort((a, b) => a.seq - b.seq)
        return views
      },
      call: async (input) => {
        const { sessionID, seq } = input as { sessionID: string; seq: number }
        const key = `wc/call/${sessionID}/${String(seq).padStart(4, "0")}`
        const record = await ctx.storage.get(key)
        return record === undefined ? null : { ...(record as unknown as CallRecord), seq }
      },
    })

    /**
     * Announce a written or updated record to any connected TUI.
     *
     * @param sessionID - The record's session.
     * @param seq - The record's sequence number.
     */
    function announce(sessionID: string, seq: number): void {
      void rpc.events.emit("recorded", { sessionID, seq })
    }

    /** Pending compositions per session, in fire order. */
    const pending = new Map<string, Pending[]>()
    /** In-flight requests per session, in dispatch order. */
    const inflight = new Map<string, InFlight[]>()
    /** Next sequence number per session (once initialized). */
    const seq = new Map<string, number>()
    /** In-flight initialization promises, so concurrent calls for a session share one scan. */
    const seqInit = new Map<string, Promise<void>>()

    /**
     * Initialize a session's sequence counter from existing records, so a plugin
     * hot-reload (which resets the maps) never collides with prior keys.
     *
     * @param sessionID - The session to initialize.
     * @returns A promise that resolves when the counter is initialized.
     */
    function ensureSeq(sessionID: string): Promise<void> {
      const existing = seqInit.get(sessionID)
      if (existing) return existing
      const init = (async () => {
        if (seq.has(sessionID)) return
        let highest = 0
        try {
          const scan = await ctx.storage.scan({ prefix: `wc/call/${sessionID}/`, limit: 10_000 })
          for (const entry of scan.entries) {
            const number = Number(entry.key.slice(`wc/call/${sessionID}/`.length))
            if (Number.isInteger(number) && number > highest) highest = number
          }
        } catch {
          // Fresh session or scan failure: start at 1.
        }
        if (!seq.has(sessionID)) seq.set(sessionID, highest + 1)
      })()
      seqInit.set(sessionID, init)
      return init
    }

    /**
     * Reserve the next sequence number for a session.
     *
     * Concurrent reservations (a title call fires in parallel with the first
     * primary) must never receive the same number: the scan is shared, and the
     * read-and-bump below is synchronous.
     *
     * @param sessionID - The session the number is for.
     * @returns The reserved sequence number.
     */
    async function nextSeq(sessionID: string): Promise<number> {
      await ensureSeq(sessionID)
      const value = seq.get(sessionID) ?? 1
      seq.set(sessionID, value + 1)
      return value
    }

    /**
     * Store a record under its call key.
     *
     * @param sessionID - The session the record belongs to.
     * @param number - The record's sequence number.
     * @param record - The record to store.
     * @returns The storage key used.
     */
    async function save(sessionID: string, number: number, record: CallRecord): Promise<string> {
      const key = `wc/call/${sessionID}/${String(number).padStart(4, "0")}`
      await ctx.storage.set(key, record as unknown as Json)
      console.log(`[what-context] stored ${key} (${record.kind})`)
      return key
    }

    /**
     * Drop stale pending compositions and orphaned in-flight requests for a session.
     *
     * @param sessionID - The session to prune.
     */
    async function prune(sessionID: string): Promise<void> {
      const now = Date.now()
      const queue = pending.get(sessionID)
      if (queue) {
        const fresh = queue.filter((entry) => now - entry.time < STALE_MS)
        if (fresh.length !== queue.length) pending.set(sessionID, fresh)
      }
      const live = inflight.get(sessionID)
      if (live) {
        const stale = live.filter((entry) => now - entry.time >= ORPHAN_MS)
        if (stale.length > 0) {
          // Re-check after the awaits below: skip the drop when a concurrent
          // request pushed a newer list (the snapshot would clobber it).
          if (inflight.get(sessionID) === live) {
            inflight.set(sessionID, live.filter((entry) => now - entry.time < ORPHAN_MS))
          }
          for (const entry of stale) {
            try {
              const existing = (await ctx.storage.get(entry.key)) as CallRecord | undefined
              if (existing) {
                existing.orphan = true
                await ctx.storage.set(entry.key, existing as unknown as Json)
              }
            } catch {
              // Orphan marking is best-effort.
            }
          }
        }
      }
    }

    await ctx.session.hook("context", (event) => {
      void (async () => {
        await prune(event.sessionID)
        const queue = pending.get(event.sessionID) ?? []
        if (queue.length > 0) {
          console.warn(
            `[what-context] ${event.sessionID}: ${queue.length} composition(s) pending before a new context; keeping only the freshest`,
          )
        }
        pending.set(event.sessionID, [
          { time: Date.now(), composition: compose(event) },
        ])
      })()
    })

    await ctx.session.hook("http.request", (event) => {
      void (async () => {
        const number = await nextSeq(event.sessionID)
        const key = `wc/call/${event.sessionID}/${String(number).padStart(4, "0")}`
        await prune(event.sessionID)

        // Consume the pending composition for primary calls only; it is the sole
        // source of per-part boundaries. Non-primary kinds get no composition.
        let composition: CompositionShape | null = null
        if (event.kind === "primary") {
          const queue = pending.get(event.sessionID) ?? []
          if (queue.length > 0) composition = queue.shift()?.composition ?? null
          if (queue.length > 0) {
            console.warn(`[what-context] ${event.sessionID}: ${queue.length} compositions still queued after consumption`)
          }
        }

        // Read the wire body from a clone: its byte size is the overhead cross-check.
        let bodyBytes: number | null = null
        let body: string | undefined
        try {
          const text = await event.request.clone().text()
          bodyBytes = new TextEncoder().encode(text).length
          if (FULL) body = text
        } catch {
          bodyBytes = event.request.headers.get("content-length")
            ? Number(event.request.headers.get("content-length"))
            : null
        }

        const compositionRendered = composition
          ? composition.totals.systemRendered +
            composition.totals.contentRendered +
            composition.totals.toolsRendered
          : null
        const record: CallRecord = {
          v: 2,
          full: FULL,
          kind: event.kind,
          sessionID: event.sessionID,
          agent: event.agent,
          model: {
            id: event.model.id,
            providerID: event.model.providerID,
            ...(event.model.variant !== undefined ? { variant: event.model.variant } : {}),
          },
          request: {
            time: new Date().toISOString(),
            url: event.request.url,
            method: event.request.method,
            bodyBytes,
            ...(body !== undefined ? { body } : {}),
          },
          composition,
          overhead: {
            bodyBytes,
            compositionRendered,
            delta:
              bodyBytes !== null && compositionRendered !== null
                ? bodyBytes - compositionRendered
                : null,
          },
          response: null,
          tokens: null,
        }
        await save(event.sessionID, number, record)
        announce(event.sessionID, number)

        inflight.set(event.sessionID, [
          ...(inflight.get(event.sessionID) ?? []),
          { request: event.request, key, seq: number, kind: event.kind, time: Date.now() },
        ])
      })()
    })

    await ctx.session.hook("http.response", (event) => {
      void (async () => {
        // Match by object identity first; the response event carries the same
        // Request object the request event received.
        let entry = (inflight.get(event.sessionID) ?? []).find((candidate) => candidate.request === event.request)
        if (entry === undefined) {
          // Fallback: the oldest in-flight request of the same kind.
          entry = (inflight.get(event.sessionID) ?? []).find((candidate) => candidate.kind === event.kind)
        }
        if (entry === undefined) {
          console.warn(`[what-context] ${event.sessionID}: response for ${event.kind} with no in-flight request`)
          return
        }
        const live = (inflight.get(event.sessionID) ?? []).filter((candidate) => candidate !== entry)
        inflight.set(event.sessionID, live)

        let text = ""
        try {
          text = await event.response.clone().text()
        } catch {
          // Unreadable body: record the status without usage.
        }
        const usage = extractUsage(text, event.response.headers.get("content-type"))

        try {
          const existing = (await ctx.storage.get(entry.key)) as CallRecord | undefined
          if (existing === undefined) return
          existing.response = {
            time: new Date().toISOString(),
            status: event.response.status,
            usage,
            ...(FULL ? { body: text } : {}),
          }
          existing.tokens = normalizeTokens(usage)
          delete existing.orphan
          await ctx.storage.set(entry.key, existing as unknown as Json)
          announce(event.sessionID, entry.seq)
        } catch (error) {
          console.error(`[what-context] failed to update ${entry.key}:`, error)
        }
      })()
    })
  },
})
