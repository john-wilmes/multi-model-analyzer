/**
 * `mma catalog` — Backstage catalog export.
 *
 * Reads service catalog data stored during indexing (catalog:<repo> KV keys)
 * and generates Backstage-compatible catalog-info.yaml entities.
 *
 * Usage:
 *   mma catalog [--repo <name>] [--output <dir>] [--db path]
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KVStore } from "@mma/storage";
import type { ServiceCatalogEntry } from "@mma/core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface CatalogOptions {
  readonly kvStore: KVStore;
  /** If set, only export this repo. Otherwise export all repos. */
  readonly repo?: string;
  /**
   * If set, write one catalog-info.yaml per repo into this directory.
   * If not set, print combined multi-document YAML to stdout.
   */
  readonly outputDir?: string;
  readonly silent?: boolean;
}

export interface CatalogResult {
  readonly repoCount: number;
  readonly entityCount: number;
  /** Map of repoName -> YAML string written (or would-be-written). */
  readonly entities: ReadonlyMap<string, string>;
}

// ---------------------------------------------------------------------------
// Backstage entity shape (internal)
// ---------------------------------------------------------------------------

interface BackstageMetadata {
  readonly name: string;
  readonly description: string;
  readonly annotations: Record<string, string>;
  readonly tags: readonly string[];
}

interface BackstageSpec {
  readonly type: string;
  readonly lifecycle: string;
  readonly owner: string;
  readonly dependsOn: readonly string[];
}

interface BackstageEntity {
  readonly apiVersion: string;
  readonly kind: string;
  readonly metadata: BackstageMetadata;
  readonly spec: BackstageSpec;
}

// ---------------------------------------------------------------------------
// Slugification
// ---------------------------------------------------------------------------

/**
 * Convert a service name to a Backstage-compatible slug.
 * Backstage entity names must match [a-z0-9-_.] with no leading/trailing hyphens.
 * Spaces and special characters are converted to hyphens.
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")  // replace runs of non-slug chars with hyphen
    .replace(/^-+|-+$/g, "")          // strip leading/trailing hyphens
    || "unnamed-service";              // fallback if entirely stripped
}

// ---------------------------------------------------------------------------
// YAML serializer (minimal, for the known Backstage entity structure only)
// ---------------------------------------------------------------------------

function yamlStr(value: string): string {
  // Quote if the string contains characters that would confuse YAML parsers:
  // leading/trailing whitespace, colons followed by space, #, or special starts.
  if (
    value === "" ||
    /^\s|\s$/.test(value) ||
    /: /.test(value) ||
    /^[{[\|>&*!,%@`?]/.test(value) ||
    value.includes("#") ||
    value.includes('"') ||
    value.includes("'") ||
    value.includes("\n")
  ) {
    // Use double-quoted scalar; escape backslashes and double quotes
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return value;
}

function yamlStrList(values: readonly string[], indent: string): string {
  if (values.length === 0) return "[]\n";
  return "\n" + values.map((v) => `${indent}- ${yamlStr(v)}\n`).join("");
}

export function toYaml(entity: BackstageEntity): string {
  const { metadata: m, spec: s } = entity;

  const annotationLines = Object.entries(m.annotations)
    .map(([k, v]) => `    ${k}: ${yamlStr(v)}\n`)
    .join("");

  const dependsOnYaml = yamlStrList(s.dependsOn, "    ");

  return [
    `apiVersion: ${entity.apiVersion}\n`,
    `kind: ${entity.kind}\n`,
    `metadata:\n`,
    `  name: ${yamlStr(m.name)}\n`,
    `  description: ${yamlStr(m.description)}\n`,
    m.annotations && Object.keys(m.annotations).length > 0
      ? `  annotations:\n${annotationLines}`
      : "",
    `  tags: ${yamlStrList(m.tags, "  ")}`,
    `spec:\n`,
    `  type: ${s.type}\n`,
    `  lifecycle: ${s.lifecycle}\n`,
    `  owner: ${s.owner}\n`,
    `  dependsOn: ${dependsOnYaml}`,
  ].join("");
}

// ---------------------------------------------------------------------------
// Conversion: ServiceCatalogEntry -> BackstageEntity
// ---------------------------------------------------------------------------

export function catalogEntryToEntity(
  entry: ServiceCatalogEntry,
  repoName: string,
): BackstageEntity {
  const slug = slugify(entry.name);

  const dependsOn: string[] = entry.dependencies.map(
    (dep) => `component:default/${slugify(dep)}`,
  );

  return {
    apiVersion: "backstage.io/v1alpha1",
    kind: "Component",
    metadata: {
      name: slug,
      description: entry.purpose,
      annotations: {
        "mma/repo": repoName,
      },
      tags: [],
    },
    spec: {
      type: "service",
      lifecycle: "production",
      owner: "unknown",
      dependsOn,
    },
  };
}

// ---------------------------------------------------------------------------
// KV helpers
// ---------------------------------------------------------------------------

/**
 * Discover all repo names that have catalog data stored.
 * Scans KV keys with prefix "catalog:".
 */
async function discoverCatalogRepos(kvStore: KVStore): Promise<string[]> {
  const keys = await kvStore.keys("catalog:");
  return keys.map((k) => k.slice("catalog:".length)).filter((r) => r.length > 0);
}

async function loadCatalog(
  kvStore: KVStore,
  repoName: string,
): Promise<ServiceCatalogEntry[]> {
  const raw = await kvStore.get(`catalog:${repoName}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ServiceCatalogEntry[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function catalogCommand(options: CatalogOptions): Promise<CatalogResult> {
  const { kvStore, repo, outputDir, silent } = options;

  // Determine which repos to export
  let repoNames: string[];
  if (repo) {
    repoNames = [repo];
  } else {
    repoNames = await discoverCatalogRepos(kvStore);
  }

  if (repoNames.length === 0) {
    if (!silent) {
      console.log("No catalog data found. Run 'mma index' first to build the service catalog.");
    }
    return { repoCount: 0, entityCount: 0, entities: new Map() };
  }

  // Build entities per repo
  const entitiesByRepo = new Map<string, string>();
  let totalEntities = 0;

  for (const repoName of repoNames) {
    const entries = await loadCatalog(kvStore, repoName);
    if (entries.length === 0) continue;

    const yamlDocs = entries.map((entry) => {
      const entity = catalogEntryToEntity(entry, repoName);
      return toYaml(entity);
    });

    // Multi-document YAML: each document separated by "---"
    const combined = "---\n" + yamlDocs.join("---\n");
    entitiesByRepo.set(repoName, combined);
    totalEntities += entries.length;
  }

  if (outputDir) {
    await mkdir(outputDir, { recursive: true });
    for (const [repoName, yaml] of entitiesByRepo) {
      const filePath = join(outputDir, `${repoName}-catalog-info.yaml`);
      await writeFile(filePath, yaml, "utf-8");
      if (!silent) {
        console.log(`Wrote ${filePath}`);
      }
    }
  } else {
    // Print combined multi-document YAML to stdout
    if (!silent) {
      const allYaml = [...entitiesByRepo.values()].join("");
      console.log(allYaml);
    }
  }

  return {
    repoCount: entitiesByRepo.size,
    entityCount: totalEntities,
    entities: entitiesByRepo,
  };
}
