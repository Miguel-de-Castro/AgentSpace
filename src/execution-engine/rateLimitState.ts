import { getDb } from "../db/client.js";

/**
 * Shape of the `rate_limit_info` object inside a real `claude` CLI
 * `rate_limit_event` stream-json line (.claude/plans/04-usage-rate-limit.md,
 * confirmed empirically 2026-08-12). Fields are passed through verbatim —
 * this is the provider's own vocabulary, not something AgentSpace defines.
 */
export interface RateLimitInfo {
  status: string;
  resetsAt?: number;
  rateLimitType?: string;
  isUsingOverage?: boolean;
}

export interface RateLimitState {
  status: string;
  rate_limit_type: string | null;
  resets_at: number | null;
  is_using_overage: boolean;
  updated_at: string;
}

/**
 * Operational state, not a domain fact — deliberately not Evidence (see
 * schema.sql's comment on provider_rate_limit_state). Overwrites the single
 * row every time; nothing about rate-limit status is worth keeping history
 * of the way an immutable Evidence stream is.
 */
export function recordRateLimitInfo(info: RateLimitInfo): void {
  getDb()
    .prepare(
      `INSERT INTO provider_rate_limit_state (id, status, rate_limit_type, resets_at, is_using_overage, updated_at)
       VALUES ('singleton', ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         status = excluded.status,
         rate_limit_type = excluded.rate_limit_type,
         resets_at = excluded.resets_at,
         is_using_overage = excluded.is_using_overage,
         updated_at = excluded.updated_at`
    )
    .run(info.status, info.rateLimitType ?? null, info.resetsAt ?? null, info.isUsingOverage ? 1 : 0, new Date().toISOString());
}

export function getRateLimitState(): RateLimitState | undefined {
  const row = getDb().prepare("SELECT * FROM provider_rate_limit_state WHERE id = 'singleton'").get() as
    | unknown as
        | {
            status: string;
            rate_limit_type: string | null;
            resets_at: number | null;
            is_using_overage: number;
            updated_at: string;
          }
        | undefined;
  if (!row) return undefined;
  return { ...row, is_using_overage: Boolean(row.is_using_overage) };
}
