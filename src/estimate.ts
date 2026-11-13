/**
 * opencode-what-context — the E2w' estimator.
 *
 * E2w' apportions the provider-reported `prompt_tokens` by each slice's share
 * of the rendered wire body. No tokenizer runs in the plugin: the provider is
 * the ground truth for the total, and byte share is the only per-slice signal
 * the capture has. The measurement behind the estimator lives in
 * `scripts/measure.ts`.
 *
 * The slices, in wire-body order, are the three composition totals plus
 * scaffolding — the body bytes the composition does not account for (role
 * fields, message envelope, JSON structure).
 *
 * Author: Alister Lewis-Bowen <alister@lewis-bowen.org>
 */

import type { CallRecord } from "./types"

/** The four slices of a primary call's prompt, in wire-body order. */
export type SliceName = "system" | "messages" | "tools" | "scaffolding"

/** One slice of the prompt, with its rendered size and estimated tokens. */
export interface SliceEstimate {
  /** The slice identity. */
  readonly name: SliceName
  /** Rendered bytes the slice spends in the wire body. */
  readonly rendered: number
  /** Estimated tokens (provider prompt apportioned by byte share), or null. */
  readonly tokens: number | null
}

/** The E2w' estimate of one call. */
export interface Estimate {
  /** The full served prompt in tokens (`input + cache.read`), or null until the response lands. */
  readonly prompt: number | null
  /** The served completion in tokens (`output + reasoning`), or null until the response lands. */
  readonly completion: number | null
  /** Provider-reported cached prefix in tokens. */
  readonly cacheRead: number | null
  /** Provider-reported cache write in tokens. */
  readonly cacheWrite: number | null
  /** Per-slice estimates; empty when composition or usage is unavailable (non-primary kinds, pending response). */
  readonly slices: readonly SliceEstimate[]
}

/**
 * Estimate the per-slice token composition of a call.
 *
 * @param record - The stored per-call record.
 * @returns The full-served prompt and completion in tokens, and the per-slice estimates.
 */
export function estimate(record: CallRecord): Estimate {
  const tokens = record.tokens
  const prompt = tokens !== null ? tokens.input + tokens.cache.read : null
  const completion = tokens !== null ? tokens.output + tokens.reasoning : null
  const cacheRead = tokens !== null ? tokens.cache.read : null
  const cacheWrite = tokens !== null ? tokens.cache.write : null

  const body = record.overhead.bodyBytes
  const composition = record.composition
  if (prompt === null || composition === null || body === null || body <= 0) {
    return { prompt, completion, cacheRead, cacheWrite, slices: [] }
  }

  const rendered: Array<[SliceName, number]> = [
    ["system", Math.max(0, composition.totals.systemRendered)],
    ["messages", Math.max(0, composition.totals.contentRendered)],
    ["tools", Math.max(0, composition.totals.toolsRendered)],
    ["scaffolding", Math.max(0, record.overhead.delta ?? 0)],
  ]
  const slices: SliceEstimate[] = rendered.map(([name, bytes]) => ({
    name,
    rendered: bytes,
    tokens: Math.round((prompt * bytes) / body),
  }))
  return { prompt, completion, cacheRead, cacheWrite, slices }
}
