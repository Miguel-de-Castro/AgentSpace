import { ulid } from "ulid";

/**
 * Every table's primary key is a ULID (docs/07-SCHEMA_API_CONTRACT.md §3
 * conventions): sortable by creation time without a separate index, which
 * Timeline and Trust Ledger queries both lean on.
 */
export function newId(): string {
  return ulid();
}
