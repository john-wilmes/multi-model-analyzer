import type { KVStore } from "@mma/storage";

// ─── SARIF helpers ─────────────────────────────────────────

export interface SarifFinding {
  ruleId: string;
  level: string;
  message: { text: string };
  locations?: Array<{
    logicalLocations?: Array<{
      fullyQualifiedName?: string;
      kind?: string;
      properties?: Record<string, unknown>;
    }>;
  }>;
  properties?: Record<string, unknown>;
}

export async function getAllFindings(
  kvStore: KVStore,
  sarifKey: string,
): Promise<Map<string, SarifFinding[]>> {
  const byRepo = new Map<string, SarifFinding[]>();
  const keys = await kvStore.keys(`sarif:${sarifKey}:`);
  for (const key of keys) {
    const repo = key.slice(`sarif:${sarifKey}:`.length);
    const raw = await kvStore.get(key);
    if (raw) {
      byRepo.set(repo, JSON.parse(raw) as SarifFinding[]);
    }
  }
  return byRepo;
}

export function flattenFindings(
  byRepo: Map<string, SarifFinding[]>,
): Array<{ repo: string; finding: SarifFinding }> {
  const flat: Array<{ repo: string; finding: SarifFinding }> = [];
  for (const [repo, findings] of byRepo) {
    for (const finding of findings) {
      flat.push({ repo, finding });
    }
  }
  return flat;
}

export function fqn(finding: SarifFinding): string {
  return finding.locations?.[0]?.logicalLocations?.[0]?.fullyQualifiedName ?? "";
}
