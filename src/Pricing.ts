/**
 * Estimated model pricing.
 *
 * The `claude-p` backend cannot report real cost — the interactive TUI does
 * not expose billing data, so `claude-p` leaves cost fields as placeholders.
 * ralphloop recovers the real *token counts* from the session transcript
 * (`SessionUsage.ts`) and then estimates the dollar cost here.
 *
 * IMPORTANT: these are list prices, USD per 1M tokens, ESTIMATES ONLY. They
 * must be kept in sync with https://www.anthropic.com/pricing whenever model
 * pricing changes. The `claude` backend always uses claude's own reported
 * cost and never touches this table.
 */

import type { AgentUsage } from "./types.js";

interface ModelPrice {
  inputPerMtok: number;
  outputPerMtok: number;
  /** Writing into the prompt cache (more expensive than a plain input token). */
  cacheWritePerMtok: number;
  /** Reading from the prompt cache (much cheaper than a plain input token). */
  cacheReadPerMtok: number;
}

/**
 * Matched by substring against the model name, first hit wins. Family-level
 * granularity is enough for an estimate and survives point releases
 * (`claude-sonnet-4-6` → `claude-sonnet-4-7` keeps working).
 */
const PRICE_TABLE: ReadonlyArray<{ match: RegExp; price: ModelPrice }> = [
  {
    match: /opus/i,
    price: { inputPerMtok: 15, outputPerMtok: 75, cacheWritePerMtok: 18.75, cacheReadPerMtok: 1.5 },
  },
  {
    match: /sonnet/i,
    price: { inputPerMtok: 3, outputPerMtok: 15, cacheWritePerMtok: 3.75, cacheReadPerMtok: 0.3 },
  },
  {
    match: /haiku/i,
    price: { inputPerMtok: 1, outputPerMtok: 5, cacheWritePerMtok: 1.25, cacheReadPerMtok: 0.1 },
  },
];

/**
 * Estimate the USD cost of one agent run from its token usage. Returns null
 * for an unrecognised model so callers can fall back to "cost unknown" rather
 * than silently reporting $0.
 */
export function estimateCostUsd(model: string, usage: AgentUsage): number | null {
  const entry = PRICE_TABLE.find((p) => p.match.test(model));
  if (!entry) return null;
  const p = entry.price;
  const M = 1_000_000;
  return (
    (usage.inputTokens * p.inputPerMtok) / M +
    (usage.outputTokens * p.outputPerMtok) / M +
    (usage.cacheCreationInputTokens * p.cacheWritePerMtok) / M +
    (usage.cacheReadInputTokens * p.cacheReadPerMtok) / M
  );
}
