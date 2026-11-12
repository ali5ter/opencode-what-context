/**
 * opencode-what-context — build step 1: seam prototype.
 *
 * Registers the `context`, `http.request`, and `http.response` session hooks and records
 * each fired event's shape into plugin storage (`ctx.storage`).
 *
 * Redaction policy: conversation content is never persisted — known conversation parts
 * (message text, reasoning, tool input and results) are reduced to byte counts. Long
 * strings elsewhere keep only a short sample so parts can be identified; strings at or
 * under a short length are structural and are kept verbatim. Credential headers are
 * redacted.
 *
 * Dumps are stored under `wc/<hook>/<sessionID>/<seq>` and each store is logged to the
 * server console.
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import { Plugin } from "@opencode/plugin"
import type {
  SessionContext,
  SessionHttpRequest,
  SessionHttpResponse,
} from "@opencode/plugin/promise/session"

/** A JSON-safe value, structurally compatible with `Schema.Json`. */
type Shape = null | boolean | number | string | Shape[] | { [key: string]: Shape }

/** Strings at or under this length are treated as structural and kept verbatim. */
const SHORT = 120

/** Sample length kept for longer strings under soft redaction. */
const SAMPLE = 48

/** Maximum recursion depth of the shape walker. */
const MAX_DEPTH = 4

/** Maximum number of array elements described; the rest is counted. */
const MAX_ITEMS = 20

/** Maximum number of object keys described; the rest is counted. */
const MAX_KEYS = 30

/** Maximum number of tools described in the context hook's tool map. */
const MAX_TOOLS = 40

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
 * Coerce a value to a string, treating non-strings as empty.
 *
 * @param value - The value to coerce.
 * @returns The value when it is a string, otherwise the empty string.
 */
function str(value: unknown): string {
  return typeof value === "string" ? value : ""
}

/** Redaction mode: soft keeps a short sample of long strings; hard keeps only the byte count. */
type Redaction = "soft" | "hard"

/**
 * Describe a string under the given redaction mode.
 *
 * @param text - The string to describe.
 * @param redaction - The redaction mode to apply to long strings.
 * @returns The string itself when short, otherwise a byte-count (and sample) record.
 */
function describeString(text: string, redaction: Redaction): Shape {
  if (text.length <= SHORT) return text
  if (redaction === "hard") return { __redacted: true, bytes: utf8(text) }
  return { bytes: utf8(text), sample: text.slice(0, SAMPLE) }
}

/**
 * Recursively describe an untrusted value for storage.
 *
 * @param value - The value to describe.
 * @param redaction - The redaction mode applied to long strings.
 * @param depth - Remaining recursion depth.
 * @param seen - Object identities already visited, for cycle detection.
 * @returns A JSON-safe description of `value`.
 */
function describe(value: unknown, redaction: Redaction, depth: number, seen: Set<object>): Shape {
  if (value === null || value === undefined) return null
  if (typeof value === "number" || typeof value === "boolean") return value
  if (typeof value === "string") return describeString(value, redaction)
  if (typeof value === "bigint") return value.toString()
  if (typeof value === "function" || typeof value === "symbol") return { __kind: typeof value }
  if (value instanceof Uint8Array) return { __kind: "bytes", bytes: value.length }
  if (value instanceof ReadableStream) return { __kind: "stream" }
  if (seen.has(value as object)) return { __kind: "circular" }
  if (depth <= 0) return { __kind: "truncated" }
  seen.add(value as object)
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => describe(item, redaction, depth - 1, seen))
    if (value.length > MAX_ITEMS) items.push({ __omitted: value.length - MAX_ITEMS })
    return items
  }
  const object = value as Record<string, unknown>
  const keys = Object.keys(object)
  const out: { [key: string]: Shape } = {}
  for (const key of keys.slice(0, MAX_KEYS)) {
    out[key] = describe(object[key], redaction, depth - 1, seen)
  }
  if (keys.length > MAX_KEYS) out.__omittedKeys = keys.length - MAX_KEYS
  return out
}

/** Header names whose values must never be persisted. */
const secretHeader = /^(authorization|proxy-authorization|api-key|x-api-key|cookie|set-cookie|x-forwarded-[a-z-]+)$/i

/**
 * Describe request or response headers, redacting credentials.
 *
 * @param headers - The headers to describe.
 * @returns A record of header name to value, with secret values replaced.
 */
function describeHeaders(headers: Headers): Shape {
  const out: { [key: string]: Shape } = {}
  for (const [name, value] of headers.entries()) {
    out[name] = secretHeader.test(name) ? "__redacted__" : value
  }
  return out
}

/**
 * Describe the instructions part's per-source list, sampled so sources can be told apart.
 *
 * @param metadata - The system part's metadata, if any.
 * @returns One record per instruction source, or null when absent.
 */
function describeInstructions(metadata: unknown): Shape {
  const experimental = (metadata ?? {}) as {
    experimental?: { instructions?: Array<{ key: string; text: string }> }
  }
  const sources = experimental.experimental?.instructions
  if (!Array.isArray(sources)) return null
  return sources.map((source) => ({
    key: source.key,
    bytes: utf8(source.text),
    sample: source.text.slice(0, SAMPLE),
  }))
}

/**
 * Describe one system part.
 *
 * @param part - The system part as fired by OpenCode.
 * @returns The redacted shape of the part.
 */
function describeSystemPart(part: unknown): Shape {
  const p = part as Record<string, unknown>
  const text = str(p["text"])
  return {
    type: str(p["type"]) || "unknown",
    bytes: utf8(text),
    sample: text.slice(0, SAMPLE),
    cache: p["cache"] !== undefined ? describe(p["cache"], "soft", 2, new Set()) : null,
    instructions: describeInstructions(p["metadata"]),
  }
}

/**
 * Describe one message content part. Conversation content is reduced to byte counts;
 * structural fields are kept.
 *
 * @param part - The content part as fired by OpenCode.
 * @returns The redacted shape of the part.
 */
function describeContentPart(part: unknown): Shape {
  const p = part as Record<string, unknown>
  const type = str(p["type"])
  if (type === "text") return { type, bytes: utf8(str(p["text"])) }
  if (type === "reasoning") {
    return {
      type,
      bytes: utf8(str(p["text"])),
      encryptedBytes: typeof p["encrypted"] === "string" ? utf8(str(p["encrypted"])) : null,
    }
  }
  if (type === "tool-call") {
    return {
      type,
      id: str(p["id"]) || null,
      tool: str(p["name"]) || null,
      namespace: typeof p["namespace"] === "string" ? p["namespace"] : null,
      inputBytes: utf8(JSON.stringify(p["input"] ?? null)),
      providerExecuted: p["providerExecuted"] === true ? true : null,
    }
  }
  if (type === "tool-result") {
    const result = (p["result"] ?? {}) as Record<string, unknown>
    return {
      type,
      id: str(p["id"]) || null,
      tool: str(p["name"]) || null,
      resultType: str(result["type"]) || null,
      resultBytes: utf8(JSON.stringify(result["value"] ?? null)),
    }
  }
  if (type === "media") {
    return { type, filename: str(p["filename"]) || null, media: describe(p["media"], "hard", 2, new Set()) }
  }
  if (type === "compaction") {
    return {
      type,
      provider: str(p["provider"]) || null,
      textBytes: utf8(str(p["text"])),
      hasSummary: p["text"] !== null,
    }
  }
  return { type: type || "unknown", shape: describe(part, "hard", 2, new Set()) }
}

/**
 * Describe one message.
 *
 * @param message - The message as fired by OpenCode.
 * @returns The redacted shape of the message.
 */
function describeMessage(message: unknown): Shape {
  const m = message as Record<string, unknown>
  const content = Array.isArray(m["content"]) ? m["content"] : []
  return {
    role: str(m["role"]) || "unknown",
    id: typeof m["id"] === "string" ? m["id"] : null,
    content: content.map((part) => describeContentPart(part)),
  }
}

/**
 * Describe the context hook's tool map: per tool, description and schema sizes.
 *
 * @param tools - The tools record as fired by OpenCode.
 * @returns The redacted shape of the tool map.
 */
function describeTools(tools: Record<string, { description: string; input: unknown }>): Shape {
  const entries = Object.entries(tools)
  const out: { [key: string]: Shape } = {}
  for (const [name, tool] of entries.slice(0, MAX_TOOLS)) {
    out[name] = {
      descriptionBytes: utf8(tool.description ?? ""),
      descriptionSample: (tool.description ?? "").slice(0, SAMPLE),
      schemaBytes: utf8(JSON.stringify(tool.input ?? null)),
    }
  }
  if (entries.length > MAX_TOOLS) out.__omitted = entries.length - MAX_TOOLS
  return { count: entries.length, tools: out }
}

/**
 * Describe a `context` hook event: assembled system parts, messages, tools, and options.
 *
 * @param event - The context event as fired by OpenCode.
 * @returns The redacted shape of the event.
 */
function describeContext(event: SessionContext): Shape {
  return {
    hook: "context",
    time: new Date().toISOString(),
    sessionID: event.sessionID,
    agent: event.agent,
    model: describe(event.model, "soft", 2, new Set()),
    system: event.system.map(describeSystemPart),
    messages: event.messages.map(describeMessage),
    tools: describeTools(event.tools),
    options: describe(event.options, "hard", 3, new Set()),
  }
}

/**
 * Describe a wire body: JSON bodies are parsed and walked; other bodies are sized and
 * sampled.
 *
 * @param text - The full body text, read from a clone.
 * @param contentType - The body's content type, if any.
 * @returns The redacted shape of the body.
 */
function describeBody(text: string, contentType: string | null): Shape {
  if (text.length === 0) return { bytes: 0, empty: true }
  if (contentType !== null && contentType.includes("json")) {
    try {
      const parsed: unknown = JSON.parse(text)
      return { bytes: utf8(text), parsed: describe(parsed, "soft", MAX_DEPTH, new Set()) }
    } catch {
      return { bytes: utf8(text), parseError: true }
    }
  }
  return { bytes: utf8(text), sample: text.slice(0, SHORT) }
}

/**
 * Extract provider-reported usage from a response body.
 *
 * @param text - The full response body text, read from a clone.
 * @param contentType - The body's content type, if any.
 * @returns The last usage object found in the body, or null.
 */
function extractUsage(text: string, contentType: string | null): Shape {
  if (contentType !== null && contentType.includes("json")) {
    try {
      const body = JSON.parse(text) as { usage?: unknown }
      return body.usage !== undefined ? describe(body.usage, "soft", 3, new Set()) : null
    } catch {
      return null
    }
  }
  if (contentType === null || contentType.includes("event-stream") || text.startsWith("data:")) {
    let last: Shape = null
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      const payload = line.slice(5).trim()
      if (payload === "[DONE]") continue
      try {
        const frame = JSON.parse(payload) as { usage?: unknown }
        if (frame.usage !== undefined) last = describe(frame.usage, "soft", 3, new Set())
      } catch {
        // Keepalive or non-JSON frame: nothing to record.
      }
    }
    return last
  }
  return null
}

/**
 * Describe an `http.request` hook event: the wire request after provider lowering.
 *
 * @param event - The http.request event as fired by OpenCode.
 * @returns The redacted shape of the request, with the body read from a clone.
 */
async function describeHttpRequest(event: SessionHttpRequest): Promise<Shape> {
  const text = await event.request.clone().text()
  return {
    hook: "http.request",
    time: new Date().toISOString(),
    sessionID: event.sessionID,
    agent: event.agent,
    model: describe(event.model, "soft", 2, new Set()),
    kind: event.kind,
    url: event.request.url,
    method: event.request.method,
    headers: describeHeaders(event.request.headers),
    body: describeBody(text, event.request.headers.get("content-type")),
  }
}

/**
 * Describe an `http.response` hook event, extracting provider-reported usage.
 *
 * @param event - The http.response event as fired by OpenCode.
 * @returns The redacted shape of the response, with the body read from a clone.
 */
async function describeHttpResponse(event: SessionHttpResponse): Promise<Shape> {
  const text = await event.response.clone().text()
  const contentType = event.response.headers.get("content-type")
  return {
    hook: "http.response",
    time: new Date().toISOString(),
    sessionID: event.sessionID,
    agent: event.agent,
    model: describe(event.model, "soft", 2, new Set()),
    kind: event.kind,
    status: event.response.status,
    statusText: event.response.statusText,
    headers: describeHeaders(event.response.headers),
    body: {
      contentType,
      shape: describeBody(text, contentType),
      usage: extractUsage(text, contentType),
    },
  }
}

export default Plugin.define({
  id: "opencode-what-context",
  async setup(ctx) {
    console.log(`[what-context] loaded in OpenCode ${ctx.app.version}`)

    const counters = new Map<string, number>()
    const store = (hook: string, sessionID: string, record: Promise<Shape> | Shape): void => {
      const base = `wc/${hook}/${sessionID}`
      const key = `${base}/${String((counters.get(base) ?? 0) + 1).padStart(3, "0")}`
      counters.set(base, (counters.get(base) ?? 0) + 1)
      Promise.resolve(record)
        .then((value) => ctx.storage.set(key, value))
        .then(() => console.log(`[what-context] stored ${key}`))
        .catch((error: unknown) => console.error(`[what-context] failed to store ${key}:`, error))
    }

    await ctx.session.hook("context", (event) => {
      store("context", event.sessionID, describeContext(event))
    })

    await ctx.session.hook("http.request", (event) => {
      store("http.request", event.sessionID, describeHttpRequest(event))
    })

    await ctx.session.hook("http.response", (event) => {
      store("http.response", event.sessionID, describeHttpResponse(event))
    })
  },
})
