# Ars Contexta Pattern Adoption Plan for MMA

**Source:** [agenticnotetaking/arscontexta](https://github.com/agenticnotetaking/arscontexta) (v0.8.0, MIT)
**Date:** 2026-04-06
**Reference files:** `docs/borrowed-patterns/arscontexta-refs/`

---

## Pattern 1: KV Namespace Formalization (Three-Space)

### Source Pattern

Arscontexta's three-space architecture (`self/`, `notes/`, `ops/`) separates data by **durability profile**: permanent identity, permanent knowledge, and temporal operations. The key insight is the six failure modes of conflation — when temporal data mixes with durable data, search pollution, stale state, and lost insights follow predictably.

Reference: `arscontexta-refs/three-spaces.md`

### Current MMA State

MMA's KV store uses 59 `kvStore.set()` call sites with ad-hoc key prefixes. The keys implicitly fall into three durability tiers, but the tiers aren't formalized:

| Current prefix | Durability | Example |
|---|---|---|
| `summary:t3:<entityId>` | Permanent (LLM-generated, expensive to regenerate) | Tier-3 semantic summaries |
| `sarif:repo:<repo>` | Semi-permanent (regenerated on index, authoritative for dashboard) | Per-repo SARIF aggregates |
| `metrics:<repo>`, `patterns:<repo>`, `flags:<repo>` | Temporal (regenerated every index run) | Per-run analysis outputs |
| `pipelineComplete:<repo>` | Temporal (per-run marker) | Phase completion flags |
| `commit:<repo>` | Temporal (change detection state) | Last-indexed commit hash |
| `sarif:latest`, `sarif:latest:index` | Semi-permanent (system-wide aggregates) | Dashboard landing page data |
| `flagRegistry` | Semi-permanent (accumulated across runs) | Canonical flag enum |

### Failure Modes Already Observed

1. **Ops-into-notes (PR #107):** Tier-3 LLM summaries were generated but not persisted to KV. Root cause: no clear boundary between "this key is durable" and "this key is temporal." The developer writing phase-summarization didn't realize t3 summaries needed explicit persistence because all KV writes looked the same.

2. **Dashboard crash from shape mismatch:** KV values stored by `runCrossRepoModels` were wrapper objects, but dashboard handlers expected bare arrays. No schema contract existed because all KV writes use the same `kvStore.set(key, JSON.stringify(value))` pattern.

### Implementation Plan

#### Step 1: Define key taxonomy

Create `packages/storage/src/kv-namespaces.ts`:

```typescript
/**
 * KV key namespace taxonomy.
 *
 * Three durability tiers, inspired by arscontexta's three-space architecture:
 *
 * - `run:` — Temporal. Regenerated every index run. Safe to delete on re-index.
 *   Includes: metrics, patterns, flags, services, naming, hotspots, logTemplates,
 *   packageJsons, logCoOccurrence, reachCounts, config-model, faultTrees,
 *   catalog, docs:functional, circularDeps, barrels, debt, pipelineComplete,
 *   commit, _packageRoots, summary:t1, summary:t2, flagRegistry:checked
 *
 * - `durable:` — Permanent. Expensive to regenerate (LLM calls) or accumulated
 *   across runs. Never deleted on re-index.
 *   Includes: summary:t3 (LLM-generated semantic summaries), flagRegistry
 *   (accumulated canonical enum), cross-repo resolved symbols
 *
 * - `view:` — Semi-permanent. Derived from run data, consumed by dashboard.
 *   Regenerated each run but authoritative between runs.
 *   Includes: sarif:repo:*, sarif:latest, sarif:latest:index,
 *   sarif:<ruleId>:<repo> (per-finding-type aggregates)
 */

// Key builder functions enforce the taxonomy at call sites.
export const KV = {
  // Temporal — regenerated every run
  run: {
    metrics:        (repo: string) => `run:metrics:${repo}`,
    metricsSummary: (repo: string) => `run:metricsSummary:${repo}`,
    patterns:       (repo: string) => `run:patterns:${repo}`,
    flags:          (repo: string) => `run:flags:${repo}`,
    configInventory:(repo: string) => `run:config-inventory:${repo}`,
    logTemplates:   (repo: string) => `run:logTemplates:${repo}`,
    naming:         (repo: string) => `run:naming:${repo}`,
    hotspots:       (repo: string) => `run:hotspots:${repo}`,
    packageJsons:   (repo: string) => `run:packageJsons:${repo}`,
    logCoOccurrence:(repo: string) => `run:logCoOccurrence:${repo}`,
    reachCounts:    (repo: string) => `run:reachCounts:${repo}`,
    configModel:    (repo: string) => `run:config-model:${repo}`,
    faultTrees:     (repo: string) => `run:faultTrees:${repo}`,
    catalog:        (repo: string) => `run:catalog:${repo}`,
    docsFunctional: (repo: string) => `run:docs:functional:${repo}`,
    circularDeps:   (repo: string) => `run:circularDeps:${repo}`,
    barrels:        (repo: string) => `run:barrels:${repo}`,
    debt:           (repo: string) => `run:debt:${repo}`,
    debtSystem:     ()             => `run:debt:system`,
    commit:         (repo: string) => `run:commit:${repo}`,
    packageRoots:   ()             => `run:_packageRoots`,
    summaryT1:      (repo: string, path: string, hash: string) => `run:summary:t1:${repo}:${path}:${hash}`,
    summaryT2:      (repo: string, id: string) => `run:summary:t2:${repo}:${id}`,
    pipelineComplete:(repo: string) => `run:pipelineComplete:${repo}`,
    flagRegistryChecked: ()        => `run:flagRegistry:checked`,
  },

  // Durable — expensive or accumulated, never auto-deleted
  durable: {
    summaryT3:     (entityId: string) => `durable:summary:t3:${entityId}`,
    flagRegistry:  ()                 => `durable:flagRegistry`,
  },

  // View — dashboard-facing aggregates, regenerated but authoritative
  view: {
    sarifRepo:     (repo: string)     => `view:sarif:repo:${repo}`,
    sarifLatest:   ()                 => `view:sarif:latest`,
    sarifIndex:    ()                 => `view:sarif:latest:index`,
    sarifByRule:   (rule: string, repo: string) => `view:sarif:${rule}:${repo}`,
  },
} as const;
```

#### Step 2: Migrate existing call sites

All 59 `kvStore.set()` and corresponding `kvStore.get()` calls in `apps/cli/src/commands/indexing/phase-*.ts` files switch from string literals to `KV.*` builders. This is a mechanical find-and-replace per phase file.

**Migration strategy:** One phase file per commit. Each commit:
1. Import `KV` from `@mma/storage`
2. Replace string literal keys with `KV.run.*()` / `KV.durable.*()` / `KV.view.*()` calls
3. Run tests — existing tests use string literal keys in assertions, so update those too
4. Dashboard API handlers in `apps/cli/src/commands/dashboard-cmd.ts` must also migrate their `kvStore.get()` calls

**Breaking change:** KV keys change format (e.g., `metrics:my-repo` → `run:metrics:my-repo`). Existing databases become stale. Mitigation: bump DB schema version, add a one-time migration in SQLiteKVStore that renames old keys, or document that re-index is required after upgrade.

#### Step 3: Add `kvStore.deleteByPrefix('run:')` to re-index

Replace the current ad-hoc cleanup in phase-cleanup.ts with a single `kvStore.deleteByPrefix('run:')` call. This is the payoff: "delete all temporal state" becomes one operation instead of knowing every key pattern.

#### Effort Estimate

- `kv-namespaces.ts`: 1 file, ~80 lines
- Phase file migrations: 10 files, ~5 lines each (import + key replacements)
- Dashboard handler migrations: 1 file, ~20 key replacements
- Test updates: ~30 assertion string changes
- DB migration or re-index note: 1 paragraph in changelog
- **Total: ~2 PRs (namespace + migration)**

#### Risks

- Dashboard breaks if migration misses a `kvStore.get()` call. Mitigation: grep for all bare string KV keys after migration.
- Existing databases require re-index. Acceptable for a pre-1.0 tool.

---

## Pattern 2: Write-Time Schema Validation

### Source Pattern

Arscontexta's `write-validate.sh` hook fires on every Write operation, checks files in the knowledge space for required YAML fields (`description`, `topics`, frontmatter), and injects warnings as `additionalContext`. Non-blocking: the write succeeds, but the agent sees a warning.

Reference: `arscontexta-refs/write-validate.sh`

### Current MMA State

KV writes are bare `kvStore.set(key, JSON.stringify(value))` with no validation. The dashboard has crashed from:
- Missing `logicalLocations[].properties.repo` in SARIF results
- Wrapper objects where bare arrays were expected
- Null/undefined values serialized as `"null"` strings

### Implementation Plan

#### Step 1: Define invariants per namespace

Create `packages/storage/src/kv-validators.ts`:

```typescript
import { type SarifResult } from '@mma/core';

/** Validation result — non-blocking, returns warnings. */
export interface KVValidation {
  valid: boolean;
  warnings: string[];
}

/**
 * Validates a KV value before write. Non-blocking — logs warnings
 * but does not prevent the write. Modeled after arscontexta's
 * write-validate.sh hook (tier-1 schema enforcement).
 */
export function validateKVWrite(key: string, value: string): KVValidation {
  const warnings: string[] = [];

  // Parse JSON — all MMA KV values should be valid JSON or plain strings
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    // Plain string values (commit hashes, "true" markers) are fine
    if (key.startsWith('view:sarif:') || key.startsWith('run:metrics:')) {
      warnings.push(`${key}: expected JSON, got plain string`);
    }
    return { valid: warnings.length === 0, warnings };
  }

  // SARIF view validation
  if (key.startsWith('view:sarif:')) {
    validateSarifValue(key, parsed, warnings);
  }

  // Durable summary validation
  if (key.startsWith('durable:summary:t3:')) {
    if (typeof parsed !== 'object' || parsed === null) {
      warnings.push(`${key}: tier-3 summary must be an object`);
    }
  }

  // Array-expected keys (dashboard consumers iterate these)
  const arrayExpectedPrefixes = [
    'run:patterns:', 'run:flags:', 'run:hotspots:',
    'run:circularDeps:', 'run:barrels:',
  ];
  for (const prefix of arrayExpectedPrefixes) {
    if (key.startsWith(prefix) && !Array.isArray(parsed)) {
      warnings.push(`${key}: dashboard expects array, got ${typeof parsed}`);
    }
  }

  return { valid: warnings.length === 0, warnings };
}

function validateSarifValue(key: string, parsed: unknown, warnings: string[]): void {
  // sarif:repo:<repo> and sarif:latest should be SARIF logs
  if (key.match(/^view:sarif:(repo:|latest$)/)) {
    if (typeof parsed !== 'object' || parsed === null) {
      warnings.push(`${key}: expected SARIF log object`);
      return;
    }
    const log = parsed as Record<string, unknown>;
    if (!Array.isArray(log.runs)) {
      warnings.push(`${key}: SARIF log missing 'runs' array`);
    }
  }

  // sarif:<ruleId>:<repo> should be arrays of SarifResult
  if (key.match(/^view:sarif:[^:]+:[^:]+$/) && !key.includes('repo:') && !key.includes('latest')) {
    if (!Array.isArray(parsed)) {
      warnings.push(`${key}: per-rule SARIF should be array of results`);
    } else {
      for (const [i, result] of (parsed as SarifResult[]).entries()) {
        if (!result.ruleId) {
          warnings.push(`${key}[${i}]: missing ruleId`);
        }
        if (!result.locations?.length && !result.logicalLocations?.length) {
          warnings.push(`${key}[${i}]: missing both locations and logicalLocations`);
        }
      }
    }
  }
}
```

#### Step 2: Wire into KV store

Add optional validator to `SQLiteKVStore.set()`:

```typescript
// In SQLiteKVStore constructor, accept optional validator
constructor(db: Database, options?: { validator?: (key: string, value: string) => KVValidation }) {
  this.validator = options?.validator;
}

async set(key: string, value: string): Promise<void> {
  if (this.validator) {
    const result = this.validator(key, value);
    if (!result.valid) {
      for (const w of result.warnings) {
        console.warn(`[kv-validate] ${w}`);
      }
    }
  }
  // existing write logic
}
```

#### Step 3: Enable in production, disable in tests

Pass the validator when constructing the KV store in `index-cmd.ts`. Omit it in test fixtures (InMemoryKVStore doesn't need it). The validator is **non-blocking** — it logs warnings but never throws.

#### Effort Estimate

- `kv-validators.ts`: 1 file, ~100 lines
- SQLiteKVStore modification: ~10 lines
- index-cmd.ts wiring: ~3 lines
- **Total: 1 PR**

#### Risks

- False positives from validator could create log noise. Mitigation: start with only the SARIF and array-shape checks (the two bug classes we've actually hit), expand later.
- Performance: JSON.parse on every write adds overhead. Mitigation: only validate `view:` and `durable:` prefixes (skip `run:` — temporal data is cheap to regenerate).

---

## Pattern 3: Condition-Based Signals at Session Start

### Source Pattern

Arscontexta's `session-orient.sh` counts files in `ops/observations/`, `ops/tensions/`, `ops/sessions/`, and `inbox/`, then emits threshold-triggered warnings:

```bash
if [ "$OBS_COUNT" -ge 10 ]; then
  echo "CONDITION: $OBS_COUNT pending observations. Consider /rethink."
fi
```

This prevents stale-state amnesia across sessions — the agent sees what needs attention without manually querying.

Reference: `arscontexta-refs/session-orient.sh`

### Current MMA State

The SessionStart hook injects memory and recent git history but has no awareness of the analysis pipeline state. Between sessions, the agent doesn't know:
- How many repos are indexed vs. pending
- Whether tier-3 enrichment has stale/missing entries
- If SARIF findings have accumulated since last review
- If the KV store has grown beyond expected size

### Implementation Plan

#### Step 1: Add pipeline health query functions

Create `packages/storage/src/health-signals.ts`:

```typescript
import { KVStore } from './kv.js';
import { GraphStore } from './graph.js';

export interface PipelineHealthSignal {
  condition: string;  // Human-readable description
  severity: 'info' | 'warn';
}

export async function getPipelineHealthSignals(
  kvStore: KVStore,
  graphStore: GraphStore,
): Promise<PipelineHealthSignal[]> {
  const signals: PipelineHealthSignal[] = [];

  // 1. Repos indexed vs. repos in config
  const completedKeys = await kvStore.keys('run:pipelineComplete:');

  // 2. Tier-3 enrichment coverage
  const t3Keys = await kvStore.keys('durable:summary:t3:');
  const t1Keys = await kvStore.keys('run:summary:t1:');
  if (t1Keys.length > 0 && t3Keys.length === 0) {
    signals.push({
      condition: `${t1Keys.length} tier-1 summaries exist but 0 tier-3 (LLM) enrichments. Run with --enrich.`,
      severity: 'info',
    });
  } else if (t1Keys.length > 0 && t3Keys.length < t1Keys.length * 0.1) {
    signals.push({
      condition: `Only ${t3Keys.length}/${t1Keys.length} symbols have tier-3 enrichment (${Math.round(t3Keys.length / t1Keys.length * 100)}%).`,
      severity: 'info',
    });
  }

  // 3. SARIF findings count
  const sarifIndexRaw = await kvStore.get('view:sarif:latest:index');
  if (sarifIndexRaw) {
    try {
      const idx = JSON.parse(sarifIndexRaw);
      const totalFindings = Object.values(idx.ruleCounts ?? {}).reduce(
        (a: number, b: unknown) => a + (typeof b === 'number' ? b : 0), 0
      );
      if (totalFindings > 1000) {
        signals.push({
          condition: `${totalFindings} SARIF findings accumulated. Consider reviewing with 'mma practices'.`,
          severity: 'info',
        });
      }
    } catch { /* ignore parse errors */ }
  }

  // 4. Graph edge count (scale indicator)
  const edgeCount = await graphStore.getEdgeCount?.() ?? 0;
  if (edgeCount > 50000) {
    signals.push({
      condition: `Graph has ${edgeCount.toLocaleString()} edges. Large-scale queries may be slow.`,
      severity: 'info',
    });
  }

  return signals;
}
```

#### Step 2: Wire into CLI startup

In `apps/cli/src/commands/index-cmd.ts` (or a shared CLI init function), call `getPipelineHealthSignals()` after opening the DB and log any signals before the pipeline starts:

```typescript
const signals = await getPipelineHealthSignals(kvStore, graphStore);
for (const s of signals) {
  logger.info(`[health] ${s.condition}`);
}
```

#### Step 3: Expose via SessionStart hook context (optional)

Add a `mma health` subcommand that outputs signals as JSON. The SessionStart hook can call `node apps/cli/dist/index.js health --db <path>` and inject the result. This is the arscontexta pattern of injecting condition-based signals into the agent's context at session start.

#### Effort Estimate

- `health-signals.ts`: 1 file, ~80 lines
- CLI wiring: ~5 lines
- Optional `health` subcommand: ~30 lines
- **Total: 1 PR**

#### Risks

- DB access at session start adds latency. Mitigation: the queries are lightweight (key prefix counts), should be <100ms on SQLite.
- Signals may be noisy for new users. Mitigation: only emit `warn`-level signals for actionable issues.

---

## Pattern 4: Kernel Primitives (Output Invariants)

### Source Pattern

Arscontexta's `kernel.yaml` defines 15 universal primitives — structural invariants that every generated system must satisfy. Each primitive has:
- `enforcement: invariant | configurable`
- `validation.check` — prose assertion
- `validation.threshold` — percentage or count bound
- `cognitive_grounding` — why this invariant matters

Validation is tiered: tier-1 (hook per write), tier-2 (batch script), tier-3 (context file instructions).

Reference: `arscontexta-refs/kernel.yaml`

### Current MMA State

MMA has implicit invariants that are only discovered when violated:
- Every graph edge must have `metadata.repo` → discovered when dashboard filters broke
- Every SARIF result must have `logicalLocations[].properties.repo` → discovered when per-repo views were empty
- Every tier-3 summary must be persisted to KV → discovered in PR #107
- `pipelineComplete:<repo>` must be set after all phases → discovered when recovery mode failed

These invariants are documented in memory/MEMORY.md lessons learned, but there's no automated validation.

### Implementation Plan

#### Step 1: Define MMA kernel

Create `packages/core/src/kernel.yaml`:

```yaml
# MMA Output Kernel — Invariants for pipeline outputs
# Every index run must satisfy these. Validated post-pipeline.
schema_version: 1

primitives:
  - id: edge-repo-metadata
    name: Graph edges carry repo provenance
    description: Every GraphEdge has metadata.repo identifying its source repository.
    enforcement: invariant
    validation:
      check: "graphStore.getEdges() where metadata.repo is missing or empty"
      threshold: "0 violations"
    rationale: "Dashboard filters by repo. Edges without repo metadata are invisible to per-repo views."

  - id: sarif-logical-location
    name: SARIF results have logical locations with repo
    description: Every SarifResult has logicalLocations[0].properties.repo set.
    enforcement: invariant
    validation:
      check: "KV values matching view:sarif:*:* parsed and checked for logicalLocations"
      threshold: "0 violations"
    rationale: "Per-repo SARIF aggregation groups by this field. Missing = findings disappear."

  - id: sarif-required-fields
    name: SARIF results have ruleId and level
    description: Every SarifResult has ruleId (non-empty string) and level (error|warning|note).
    enforcement: invariant
    validation:
      check: "All SARIF results have ruleId and valid level"
      threshold: "0 violations"
    rationale: "Dashboard practices view groups by ruleId. Missing ruleId = unclassifiable finding."

  - id: t3-kv-persistence
    name: Tier-3 summaries persisted to KV
    description: Every tier-3 LLM summary generated is written to durable:summary:t3:<entityId>.
    enforcement: invariant
    validation:
      check: "Count of t3 summaries in search store vs. KV. Delta should be 0."
      threshold: "0 violations (search entries without KV backing)"
    rationale: "PR #107 bug. Without KV persistence, re-index regenerates all t3 summaries (expensive API calls)."

  - id: pipeline-complete-marker
    name: Pipeline completion markers set per repo
    description: After all phases complete for a repo, run:pipelineComplete:<repo> is set to 'true'.
    enforcement: invariant
    validation:
      check: "Every repo in config has a pipelineComplete marker"
      threshold: "0 missing repos"
    rationale: "Recovery mode uses this to determine which repos need re-processing."

  - id: kv-namespace-compliance
    name: All KV keys use namespace prefixes
    description: "Every key starts with run:, durable:, or view:. No bare keys."
    enforcement: invariant
    validation:
      check: "kvStore.keys() filtered for keys not matching ^(run|durable|view):"
      threshold: "0 violations"
    rationale: "Pattern 1 (three-space namespaces). Bare keys can't be batch-deleted or categorized."

  - id: summary-t1-per-file
    name: Tier-1 summaries exist for all parsed files
    description: Every parsed file has a run:summary:t1 entry in KV.
    enforcement: configurable
    validation:
      check: "Count of parsed files vs. t1 KV entries"
      threshold: "<5% gap"
    rationale: "T1 summaries drive search. Missing t1 = file is invisible to natural language queries."

  - id: metric-completeness
    name: Metrics computed for all repos
    description: Every repo has run:metrics:<repo> and run:metricsSummary:<repo>.
    enforcement: invariant
    validation:
      check: "repos with pipelineComplete but missing metrics keys"
      threshold: "0 missing"
    rationale: "Dashboard metrics view assumes every repo has data. Missing = NaN in charts."

  - id: view-sarif-consistency
    name: Per-repo SARIF aggregates match latest
    description: "Sum of findings across all view:sarif:repo:* equals total in view:sarif:latest."
    enforcement: configurable
    validation:
      check: "Count findings in per-repo SARIFs vs. latest aggregate"
      threshold: "<1% delta (rounding)"
    rationale: "Dashboard shows both total and per-repo counts. Inconsistency confuses users."

  - id: search-index-populated
    name: Search index has entries for indexed repos
    description: After indexing, searchStore has at least 1 entry per repo.
    enforcement: invariant
    validation:
      check: "searchStore.search('*') grouped by repo vs. repos with pipelineComplete"
      threshold: "0 repos missing from search"
    rationale: "Natural language query ('mma query') returns nothing for repos not in the search index."
```

#### Step 2: Implement batch validator

Create `packages/diagnostics/src/validate-kernel.ts`:

```typescript
import type { KVStore, GraphStore, SearchStore } from '@mma/storage';

export interface KernelViolation {
  primitiveId: string;
  description: string;
  count: number;
  examples?: string[];  // first 5 violating keys/edges
}

export async function validateKernel(
  kvStore: KVStore,
  graphStore: GraphStore,
  searchStore: SearchStore,
  repos: string[],
): Promise<KernelViolation[]> {
  const violations: KernelViolation[] = [];
  // ... implement each check from kernel.yaml
  return violations;
}
```

#### Step 3: Wire into pipeline and CLI

- Call `validateKernel()` at the end of `index-cmd.ts` after all phases complete.
- Log violations as warnings.
- Add `mma validate` subcommand that runs kernel validation against an existing DB.
- Health signals (Pattern 3) can reference kernel violation counts.

#### Effort Estimate

- `kernel.yaml`: 1 file, ~120 lines (the spec)
- `validate-kernel.ts`: 1 file, ~200 lines (10 checks, ~20 lines each)
- CLI wiring: ~15 lines
- Tests: ~100 lines (inject violations, verify detection)
- **Total: 1-2 PRs**

#### Risks

- Some checks are expensive on large DBs (full edge scan for `edge-repo-metadata`). Mitigation: sample-based validation (check 1000 random edges instead of all).
- Adding new invariants requires updating both YAML and validator. Mitigation: the YAML is the spec, the validator is the implementation — they don't auto-sync, but the YAML documents intent even if the validator lags.

---

## Pattern 5: Phase Task Queue (Resumable Pipeline)

### Source Pattern

Arscontexta's ralph orchestrator tracks each task's progress via `current_phase` and `completed_phases` in a queue file. When a subagent crashes mid-phase, the queue still shows where it stopped. Re-running ralph picks up automatically — the task is still pending at the failed phase.

Key mechanics:
- Queue entry: `{ id, type, status, current_phase, completed_phases, created, completed? }`
- Phase order defined in header: `claim: [create, reflect, reweave, verify]`
- Phase progression: after success, advance `current_phase`, append to `completed_phases`
- On crash: `current_phase` stays at failed phase, retry is automatic

### Current MMA State

MMA's pipeline tracks completion per repo via a single `pipelineComplete:<repo>` boolean. There's no per-phase tracking. When the pipeline fails mid-run:
- No way to know which phase failed for which repo
- Re-index re-runs all phases from scratch (or skips all if commit unchanged)
- The `--force-full-reindex` flag deletes the DB entirely — sledgehammer approach
- Recovery mode exists but only recovers from parse failures, not structural/heuristic failures

### Implementation Plan

#### Step 1: Define phase progression keys

Using the namespace system from Pattern 1:

```typescript
// Add to kv-namespaces.ts
run: {
  // ...existing keys...
  phaseStatus: (repo: string, phase: string) => `run:phase:${phase}:${repo}`,
  // Value: JSON { status: 'pending'|'running'|'done'|'failed', startedAt, completedAt?, error? }
}
```

Phase names (matching current phase files):
```
cleanup → ingestion → classify → parsing → structural → heuristics → models → summarization → functional → correlation
```

#### Step 2: Instrument phase functions

Each `runPhase*()` function gets bookend writes:

```typescript
// At phase start:
await kvStore.set(KV.run.phaseStatus(repo, 'structural'), JSON.stringify({
  status: 'running',
  startedAt: new Date().toISOString(),
}));

// At phase end (success):
await kvStore.set(KV.run.phaseStatus(repo, 'structural'), JSON.stringify({
  status: 'done',
  startedAt,
  completedAt: new Date().toISOString(),
}));

// On error (in catch block):
await kvStore.set(KV.run.phaseStatus(repo, 'structural'), JSON.stringify({
  status: 'failed',
  startedAt,
  error: err.message,
}));
```

#### Step 3: Add `--resume` flag

New CLI flag for `mma index`:
- Read all `run:phase:*:<repo>` keys
- For each repo, find the last `done` phase and resume from the next phase
- Skip repos where all phases are `done` and commit hasn't changed
- Re-run phases marked `failed` or `running` (crashed mid-phase)

This is a targeted alternative to `--force-full-reindex` — it re-runs only what failed.

#### Step 4: Surface in health signals (Pattern 3)

```typescript
// In health-signals.ts
const failedPhases = await kvStore.keys('run:phase:');
const failures = failedPhases.filter(async k => {
  const v = JSON.parse(await kvStore.get(k) ?? '{}');
  return v.status === 'failed';
});
if (failures.length > 0) {
  signals.push({
    condition: `${failures.length} phase failures from last run. Use --resume to retry.`,
    severity: 'warn',
  });
}
```

#### Effort Estimate

- Phase status writes: 10 phase files, ~6 lines each (start + end + catch)
- `--resume` flag logic: ~50 lines in index-cmd.ts
- Health signal integration: ~15 lines
- Tests: ~80 lines
- **Total: 1-2 PRs**

#### Risks

- Phase status writes add ~20 KV operations per repo per run. On 300 repos, that's 6000 extra writes. SQLite handles this easily (~2ms each), but worth noting.
- `--resume` with code changes between runs could produce inconsistent state (e.g., structural phase changed but heuristics uses old structural output). Mitigation: document that `--resume` is for retry-after-failure, not for incremental updates after code changes.

---

## Pattern 6: Composable Pass Registry

### Source Pattern

Arscontexta's `generators/features/` directory contains 17 composable blocks, each a self-contained Markdown file with dependencies declared. The generator assembles a CLAUDE.md by selecting blocks based on configuration dimensions, substituting domain vocabulary, and eliminating cross-references to disabled blocks.

Key mechanics:
- Each block declares `## Dependencies` (other blocks it requires)
- Selection logic driven by config dimensions set during setup
- A `derivation-manifest.md` records which blocks were enabled and why
- Vocabulary transforms adapt block content to the user's domain

### Current MMA State

MMA's 10 phase files in `apps/cli/src/commands/indexing/` are implicitly ordered by the orchestrator in `index-cmd.ts`. Phase execution is controlled by:
- `enableTsMorph` flag (skips ts-morph augmentation in phase-parsing)
- `--enrich` flag (enables tier-3 LLM in phase-summarization)
- `--skip-correlation` (skips phase-correlation)
- Recovery mode (skips phases 3-4b)

But there's no registry, no dependency DAG, and no way to add a new analysis pass without modifying `index-cmd.ts`.

### Implementation Plan

#### Step 1: Define pass manifest

Create `packages/core/src/pass-registry.ts`:

```typescript
export interface PassDefinition {
  id: string;
  name: string;
  phase: number;          // Execution order (0-7, matching current phases)
  dependencies: string[]; // IDs of passes that must run first
  enabledByDefault: boolean;
  configFlag?: string;    // Config key that controls this pass
  cliFlag?: string;       // CLI flag that controls this pass
  scope: 'per-repo' | 'global';  // per-repo (phases 3-6c) vs global (0-2, 7)
}

export const PASS_REGISTRY: PassDefinition[] = [
  { id: 'cleanup',       name: 'Stale entry cleanup',     phase: 0, dependencies: [],                    enabledByDefault: true,  scope: 'global' },
  { id: 'ingestion',     name: 'Git clone/fetch',         phase: 1, dependencies: ['cleanup'],           enabledByDefault: true,  scope: 'global' },
  { id: 'classify',      name: 'File classification',     phase: 2, dependencies: ['ingestion'],         enabledByDefault: true,  scope: 'global' },
  { id: 'parsing',       name: 'Symbol extraction',       phase: 3, dependencies: ['classify'],          enabledByDefault: true,  scope: 'per-repo' },
  { id: 'tsmorph',       name: 'Type-resolved parsing',   phase: 3, dependencies: ['parsing'],           enabledByDefault: false, scope: 'per-repo', configFlag: 'enableTsMorph' },
  { id: 'structural',    name: 'Dependency/call graphs',  phase: 4, dependencies: ['parsing'],           enabledByDefault: true,  scope: 'per-repo' },
  { id: 'heuristics',    name: 'Pattern detection',       phase: 5, dependencies: ['structural'],        enabledByDefault: true,  scope: 'per-repo' },
  { id: 'models',        name: 'Config & fault models',   phase: 6, dependencies: ['heuristics'],        enabledByDefault: true,  scope: 'per-repo' },
  { id: 'summarization', name: 'Summary generation',      phase: 6, dependencies: ['heuristics'],        enabledByDefault: true,  scope: 'per-repo' },
  { id: 'enrichment',    name: 'LLM tier-3 summaries',    phase: 6, dependencies: ['summarization'],     enabledByDefault: false, scope: 'per-repo', cliFlag: '--enrich' },
  { id: 'functional',    name: 'Service catalog',         phase: 6, dependencies: ['heuristics'],        enabledByDefault: true,  scope: 'per-repo' },
  { id: 'correlation',   name: 'Cross-repo linking',      phase: 7, dependencies: ['structural'],        enabledByDefault: true,  scope: 'global',   cliFlag: '--skip-correlation' },
  { id: 'cross-models',  name: 'Cross-repo models',       phase: 7, dependencies: ['correlation','models'], enabledByDefault: true, scope: 'global' },
];

/** Topological sort respecting dependencies. Returns pass IDs in execution order. */
export function resolvePassOrder(
  registry: PassDefinition[],
  enabledFlags: Record<string, boolean>,
): string[] {
  // Filter to enabled passes, then topological sort by dependencies
  // ...
}
```

#### Step 2: Refactor orchestrator to use registry

Replace the hardcoded phase sequence in `index-cmd.ts` with:

```typescript
const enabledPasses = resolvePassOrder(PASS_REGISTRY, {
  enableTsMorph: config.enableTsMorph ?? false,
  '--enrich': options.enrich ?? false,
  '--skip-correlation': options.skipCorrelation ?? false,
});

for (const passId of enabledPasses) {
  const pass = PASS_REGISTRY.find(p => p.id === passId)!;
  // dispatch to phase function by pass.id
}
```

#### Step 3: Add `mma passes` subcommand

Lists all registered passes, their dependencies, and enabled/disabled status for a given config:

```
$ mma passes -c mma.config.json
  ✓ cleanup          (phase 0, global)
  ✓ ingestion        (phase 1, global)
  ✓ classify         (phase 2, global)
  ✓ parsing          (phase 3, per-repo)
  ✗ tsmorph          (phase 3, per-repo) — disabled: enableTsMorph=false
  ✓ structural       (phase 4, per-repo)
  ✓ heuristics       (phase 5, per-repo)
  ✓ models           (phase 6, per-repo)
  ✓ summarization    (phase 6, per-repo)
  ✗ enrichment       (phase 6, per-repo) — disabled: --enrich not set
  ✓ functional       (phase 6, per-repo)
  ✓ correlation      (phase 7, global)
  ✓ cross-models     (phase 7, global)
```

#### Step 4: Enable third-party passes (future)

The registry pattern makes it possible to add analysis passes without modifying the orchestrator. A plugin could register a pass with `dependencies: ['structural']` and `phase: 5` to run alongside heuristics. This is the arscontexta composable-block payoff — but it's a future extension, not part of the initial implementation.

#### Effort Estimate

- `pass-registry.ts`: 1 file, ~100 lines (definitions + topological sort)
- `index-cmd.ts` refactor: ~50 lines changed (replace hardcoded sequence with registry loop)
- `mma passes` subcommand: ~40 lines
- Tests: ~60 lines (dependency resolution, flag filtering)
- **Total: 1-2 PRs**

#### Risks

- Refactoring the orchestrator is the riskiest change in this plan. The current phase sequence has implicit ordering that may not be fully captured by the dependency DAG (e.g., memory cleanup between phases, shared mutable context maps). Mitigation: keep the current execution order as the default sort-stable order within each phase number; only use the DAG for enabled/disabled filtering initially.
- Over-engineering risk: MMA has 13 passes today. A registry adds value at ~20+ passes or with third-party extensibility. For now, the main benefit is documentation and the `mma passes` command. Don't build a plugin system until there's demand.

---

## Implementation Order

| Order | Pattern | PR(s) | Dependencies |
|---|---|---|---|
| 1 | **Pattern 1: KV Namespaces** | 2 (namespace + migration) | None |
| 2 | **Pattern 2: Write Validation** | 1 | Pattern 1 (uses namespace prefixes for routing) |
| 3 | **Pattern 3: Health Signals** | 1 | Pattern 1 (uses namespace prefixes for key counting) |
| 4 | **Pattern 4: Kernel Primitives** | 1-2 | Patterns 1-3 (validates namespaced keys, surfaces in health) |
| 5 | **Pattern 5: Phase Task Queue** | 1-2 | Pattern 1 (uses namespace for phase status keys) |
| 6 | **Pattern 6: Pass Registry** | 1-2 | Pattern 5 (registry drives phase execution that task queue tracks) |

**Total estimated PRs: 7-10**

Pattern 1 is the foundation — all other patterns build on namespaced keys. Patterns 2-3 are quick wins that prevent known bug classes. Pattern 4 formalizes what we've learned from past bugs. Patterns 5-6 are architectural improvements for scale.

---

## Reference Files Preserved

The following arscontexta source files are saved at `docs/borrowed-patterns/arscontexta-refs/` for reference during implementation:

- `kernel.yaml` — 15 universal primitives with validation specs
- `three-spaces.md` — Three-space architecture and six failure modes
- `hooks.json` — Hook configuration format
- `session-orient.sh` — Session orientation with condition-based signals
- `write-validate.sh` — Non-blocking schema enforcement on writes
- `auto-commit.sh` — Async auto-commit after writes
