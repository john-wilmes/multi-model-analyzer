# Baseline Sharing

A raw MMA export lets teammates (or their AI agents) skip full reindexing. The baseline is imported once; subsequent `mma index` runs process only the delta.

## What's in a raw export

Raw exports (`mma export --raw`) contain everything the incremental engine needs:

| KV key pattern | Contents |
|----------------|----------|
| `commit:<repo>` | HEAD commit hash at index time — used to detect changed repos |
| `symbols:<repo>:<file>` | Parsed symbol cache for each file |
| `pipelineComplete:<repo>` | Pipeline completion flag — skips re-analysis for unchanged repos |
| `metrics:<repo>` | Precomputed instability, abstractness, and zone metrics |
| `patterns:<repo>` | Detected architectural patterns (service boundaries, feature flags, etc.) |
| `sarif:<category>:<repo>` | SARIF findings per category per repo |
| `sarif:latest` | Aggregated SARIF report (all categories, all repos) |

Graph edges (call graph, dependency graph) are also included in full.

A special `mma:manifest` key is written at export time with metadata about the export (see Manifest schema below).

## Manifest schema

Every export (raw or anonymized) includes a manifest at key `mma:manifest`:

```jsonc
{
  "schemaVersion": "1",        // bumped on breaking changes
  "exportedAt": "2026-03-13T18:00:00.000Z",  // ISO 8601
  "mode": "raw",               // "raw" | "anonymized"
  "repos": [
    {
      "name": "my-service",
      "url": "https://github.com/org/my-service.git",
      "branch": "main",
      "commit": "abc123def456..."
    }
  ]
}
```

The `repos` array lists every repo present in the export. During import, MMA cross-checks this list against the active config and warns on mismatches (unknown repos are imported; missing repos produce a warning but do not block indexing).

## Raw vs anonymized exports

| | Raw (`--raw`) | Anonymized (default) |
|--|--|--|
| **Purpose** | Internal team baseline sharing | External sharing, field trials |
| **Repo names** | Real | Hashed (`[REDACTED:xxxxxxxx]`) |
| **File paths** | Real | Hashed |
| **Symbol names** | Real | Hashed |
| **KV keys** | All keys | SARIF findings only |
| **Graph edges** | Included | Excluded |
| **Importable** | Yes (`mma import`) | No |
| **Mergeable** | No | Yes (`mma merge`) |

Use raw exports only within teams that already have access to the source repos. Use anonymized exports when sharing findings with external parties (vendors, consultants, open-source collaborators).

## Troubleshooting

### "Not a valid MMA export"

The imported file is missing the `mma:manifest` key. Causes:

- The file is a plain SQLite database, not an MMA export
- The export was produced by an older MMA version (pre-manifest)
- The file is corrupted

Fix: re-export from a current MMA installation.

### "Cannot import anonymized export"

`mma import` detected `mode: "anonymized"` in the manifest. Anonymized exports cannot be used as baselines because they lack the KV keys required for incremental indexing.

Fix: ask the exporter to re-run with `mma export --raw -o baseline.db`.

### Repo mismatch warnings

During import, MMA compares the manifest `repos` list against the repos in your active config. If a repo appears in the baseline but not your config (or vice versa), you'll see:

```
warn: baseline contains repo "legacy-service" not in config — skipping
warn: config repo "new-service" not in baseline — full index required
```

These are warnings, not errors. Unknown repos are imported harmlessly; repos not in the baseline are indexed from scratch. This is expected when a team member's config differs from the exporter's.

## Security note

Raw exports contain real repo names, file paths, and symbol names as they appear in your source code. Treat them with the same access controls as the source repositories themselves.

- Share only within teams that have read access to the indexed repos
- Do not post raw exports to public artifact stores or open-source repositories
- Do not commit raw exports to version control (add `*.db` to `.gitignore`)
- Use anonymized exports (`mma export`, no `--raw`) for any external sharing
