/**
 * Heavy collections skipped on every Sync DB run (not dumped / not restored).
 * Exact name match, case-insensitive.
 */
export const SYNC_DB_SKIP_COLLECTIONS = ["logs"] as const;

export function isSkippedSyncCollection(name: string): boolean {
  const lower = name.toLowerCase();
  return (SYNC_DB_SKIP_COLLECTIONS as readonly string[]).some(
    (c) => c.toLowerCase() === lower,
  );
}

export function partitionSyncCollections(names: string[]): {
  included: string[];
  skipped: string[];
} {
  const included: string[] = [];
  const skipped: string[] = [];
  for (const name of names) {
    if (isSkippedSyncCollection(name)) skipped.push(name);
    else included.push(name);
  }
  return { included, skipped };
}
