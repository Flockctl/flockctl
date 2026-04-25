-- Recomputes `total_cost_usd` for legacy usage_records that priced
-- claude-opus-4-7 at the old (claude-opus-4) rate.
--
-- Background: src/services/cost.ts used to encode Opus 4.7 at $15 / $75 /
-- $18.75 / $1.50 per 1M tokens — those are the Opus 4 prices, not Opus 4.7.
-- Actual Opus 4.7 pricing is exactly one third: $5 / $25 / $6.25 / $0.50 per
-- 1M (input / output / cache write 5m / cache read). Every historical
-- usage_record billed under anthropic/claude-opus-4-7 therefore overstates
-- cost by 3×. This migration recomputes the stored total from the already
-- correct token counts so the UI, budgets, and cost rollups reflect reality.
--
-- Rows for other models and for claude_cli (subscription, $0) are untouched.
UPDATE usage_records
SET total_cost_usd = ROUND(
  (
    COALESCE(input_tokens, 0)                  * 5.00  +
    COALESCE(output_tokens, 0)                 * 25.00 +
    COALESCE(cache_creation_input_tokens, 0)   * 6.25  +
    COALESCE(cache_read_input_tokens, 0)       * 0.50
  ) / 1000000.0,
  6
)
WHERE provider = 'anthropic' AND model = 'claude-opus-4-7';
