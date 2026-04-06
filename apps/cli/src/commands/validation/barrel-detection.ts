// ─── Barrel file detection (mirrors packages/structural/src/metrics.ts) ────

const BARREL_RE = /(?:^|[/\\])index\.[jt]sx?$/;

export function isBarrelFile(moduleId: string): boolean {
  return BARREL_RE.test(moduleId);
}
