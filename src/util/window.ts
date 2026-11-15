/**
 * Shared by /projects/:id/trust-ledger and /workspace/trust-ledger — turns a
 * short window token ("7d", "30d") into an ISO timestamp the `created_at >=
 * ?` queries in src/mission-engine/trustLedger.ts actually understand.
 */
export function windowToSince(window: string): string {
  const days = Number(window.replace(/[^0-9]/g, "")) || 30;
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
