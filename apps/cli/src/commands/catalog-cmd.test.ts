import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryKVStore } from "@mma/storage";
import type { ServiceCatalogEntry } from "@mma/core";
import {
  catalogCommand,
  catalogEntryToEntity,
  toYaml,
  slugify,
} from "./catalog-cmd.js";

// ---------------------------------------------------------------------------
// Mock node:fs/promises (writeFile / mkdir)
// ---------------------------------------------------------------------------

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
}));

import { mkdir, writeFile } from "node:fs/promises";
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<ServiceCatalogEntry> = {}): ServiceCatalogEntry {
  return {
    name: "auth-service",
    purpose: "Handles authentication and authorization",
    dependencies: [],
    apiSurface: [],
    errorHandlingSummary: "Logs errors to console",
    ...overrides,
  };
}

async function seedCatalog(
  kv: InMemoryKVStore,
  repoName: string,
  entries: ServiceCatalogEntry[],
): Promise<void> {
  await kv.set(`catalog:${repoName}`, JSON.stringify(entries));
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe("slugify", () => {
  it("lowercases and preserves safe chars", () => {
    expect(slugify("my-service")).toBe("my-service");
    expect(slugify("MyService")).toBe("myservice");
  });

  it("converts spaces and special chars to hyphens", () => {
    expect(slugify("My Service Name")).toBe("my-service-name");
    expect(slugify("auth/v2 service")).toBe("auth-v2-service");
    // Parens + space is one run of non-slug chars → single hyphen; strip leading/trailing
    expect(slugify("service (core)")).toBe("service-core");
    // Strip leading/trailing hyphens after replacement
    expect(slugify("(core)")).toBe("core");
  });

  it("collapses runs of non-slug characters to a single hyphen", () => {
    // Two spaces = one run → one hyphen
    expect(slugify("service  name")).toBe("service-name");
  });

  it("returns fallback for empty or all-stripped input", () => {
    expect(slugify("")).toBe("unnamed-service");
    expect(slugify("!!!")).toBe("unnamed-service");
  });

  it("preserves dots and underscores", () => {
    expect(slugify("my.service_v2")).toBe("my.service_v2");
  });
});

// ---------------------------------------------------------------------------
// toYaml
// ---------------------------------------------------------------------------

describe("toYaml", () => {
  it("generates valid YAML structure for a simple entity", () => {
    const entity = catalogEntryToEntity(makeEntry(), "my-repo");
    const yaml = toYaml(entity);

    expect(yaml).toContain("apiVersion: backstage.io/v1alpha1");
    expect(yaml).toContain("kind: Component");
    expect(yaml).toContain("name: auth-service");
    expect(yaml).toContain("description: Handles authentication and authorization");
    expect(yaml).toContain("mma/repo: my-repo");
    expect(yaml).toContain("type: service");
    expect(yaml).toContain("lifecycle: production");
    expect(yaml).toContain("owner: unknown");
  });

  it("renders empty dependsOn as []", () => {
    const entity = catalogEntryToEntity(makeEntry({ dependencies: [] }), "my-repo");
    const yaml = toYaml(entity);
    expect(yaml).toContain("dependsOn: []");
  });

  it("renders non-empty dependsOn as list items", () => {
    const entity = catalogEntryToEntity(
      makeEntry({ dependencies: ["payment-service", "user-service"] }),
      "my-repo",
    );
    const yaml = toYaml(entity);
    expect(yaml).toContain("- component:default/payment-service");
    expect(yaml).toContain("- component:default/user-service");
  });

  it("quotes description strings containing colons", () => {
    const entity = catalogEntryToEntity(
      makeEntry({ purpose: "Handles: auth and authz" }),
      "my-repo",
    );
    const yaml = toYaml(entity);
    // The description value should be quoted because it contains ": "
    expect(yaml).toContain('"Handles: auth and authz"');
  });

  it("emits tags as empty list", () => {
    const entity = catalogEntryToEntity(makeEntry(), "my-repo");
    const yaml = toYaml(entity);
    expect(yaml).toContain("tags: []");
  });
});

// ---------------------------------------------------------------------------
// catalogEntryToEntity
// ---------------------------------------------------------------------------

describe("catalogEntryToEntity", () => {
  it("sets apiVersion and kind correctly", () => {
    const entity = catalogEntryToEntity(makeEntry(), "my-repo");
    expect(entity.apiVersion).toBe("backstage.io/v1alpha1");
    expect(entity.kind).toBe("Component");
  });

  it("slugifies the service name for metadata.name", () => {
    const entity = catalogEntryToEntity(makeEntry({ name: "My Auth Service" }), "my-repo");
    expect(entity.metadata.name).toBe("my-auth-service");
  });

  it("sets mma/repo annotation from repoName", () => {
    const entity = catalogEntryToEntity(makeEntry(), "platform-api");
    expect(entity.metadata.annotations["mma/repo"]).toBe("platform-api");
  });

  it("converts dependencies to Backstage component refs", () => {
    const entity = catalogEntryToEntity(
      makeEntry({ dependencies: ["payment-svc", "My Notification Service"] }),
      "my-repo",
    );
    expect(entity.spec.dependsOn).toEqual([
      "component:default/payment-svc",
      "component:default/my-notification-service",
    ]);
  });

  it("sets owner to unknown and lifecycle to production", () => {
    const entity = catalogEntryToEntity(makeEntry(), "my-repo");
    expect(entity.spec.owner).toBe("unknown");
    expect(entity.spec.lifecycle).toBe("production");
    expect(entity.spec.type).toBe("service");
  });
});

// ---------------------------------------------------------------------------
// catalogCommand — empty catalog
// ---------------------------------------------------------------------------

describe("catalogCommand — empty catalog", () => {
  beforeEach(() => {
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
  });

  it("returns zero counts and prints message when no catalog keys exist", async () => {
    const kv = new InMemoryKVStore();
    const logs: string[] = [];
    const consoleSpy = vi.spyOn(console, "log").mockImplementation((m: unknown) => {
      logs.push(String(m));
    });

    const result = await catalogCommand({ kvStore: kv });

    consoleSpy.mockRestore();

    expect(result.repoCount).toBe(0);
    expect(result.entityCount).toBe(0);
    expect(result.entities.size).toBe(0);
    expect(logs.some((l) => /no catalog data/i.test(l))).toBe(true);
  });

  it("returns silently when silent=true and catalog is empty", async () => {
    const kv = new InMemoryKVStore();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const result = await catalogCommand({ kvStore: kv, silent: true });

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(result.repoCount).toBe(0);
    consoleSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// catalogCommand — single service
// ---------------------------------------------------------------------------

describe("catalogCommand — single service", () => {
  beforeEach(() => {
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
  });

  it("produces correct YAML structure for a single entry", async () => {
    const kv = new InMemoryKVStore();
    await seedCatalog(kv, "my-repo", [makeEntry()]);

    const result = await catalogCommand({ kvStore: kv, silent: true });

    expect(result.repoCount).toBe(1);
    expect(result.entityCount).toBe(1);

    const yaml = result.entities.get("my-repo")!;
    expect(yaml).toBeDefined();
    expect(yaml).toContain("apiVersion: backstage.io/v1alpha1");
    expect(yaml).toContain("kind: Component");
    expect(yaml).toContain("name: auth-service");
    expect(yaml).toContain("mma/repo: my-repo");
  });

  it("YAML output starts with --- document separator", async () => {
    const kv = new InMemoryKVStore();
    await seedCatalog(kv, "my-repo", [makeEntry()]);

    const result = await catalogCommand({ kvStore: kv, silent: true });

    const yaml = result.entities.get("my-repo")!;
    expect(yaml.startsWith("---\n")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// catalogCommand — multiple services in one repo
// ---------------------------------------------------------------------------

describe("catalogCommand — multiple services", () => {
  beforeEach(() => {
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
  });

  it("produces multiple YAML documents separated by ---", async () => {
    const kv = new InMemoryKVStore();
    await seedCatalog(kv, "my-repo", [
      makeEntry({ name: "auth-service" }),
      makeEntry({ name: "payment-service", purpose: "Handles payments" }),
    ]);

    const result = await catalogCommand({ kvStore: kv, silent: true });

    expect(result.entityCount).toBe(2);

    const yaml = result.entities.get("my-repo")!;
    // Each document is prefixed by "---\n"; two docs → two occurrences of "---\n"
    const separatorCount = (yaml.match(/^---\n/gm) ?? []).length;
    expect(separatorCount).toBeGreaterThanOrEqual(2);
    expect(yaml).toContain("name: auth-service");
    expect(yaml).toContain("name: payment-service");
  });
});

// ---------------------------------------------------------------------------
// catalogCommand — service with dependencies
// ---------------------------------------------------------------------------

describe("catalogCommand — service with dependencies", () => {
  it("populates spec.dependsOn from catalog entry dependencies", async () => {
    const kv = new InMemoryKVStore();
    await seedCatalog(kv, "my-repo", [
      makeEntry({
        name: "gateway-service",
        dependencies: ["auth-service", "payment-service"],
      }),
    ]);

    const result = await catalogCommand({ kvStore: kv, silent: true });
    const yaml = result.entities.get("my-repo")!;

    expect(yaml).toContain("- component:default/auth-service");
    expect(yaml).toContain("- component:default/payment-service");
  });
});

// ---------------------------------------------------------------------------
// catalogCommand — --repo filter
// ---------------------------------------------------------------------------

describe("catalogCommand — --repo filter", () => {
  beforeEach(() => {
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
  });

  it("exports only the specified repo when --repo is given", async () => {
    const kv = new InMemoryKVStore();
    await seedCatalog(kv, "repo-a", [makeEntry({ name: "service-a" })]);
    await seedCatalog(kv, "repo-b", [makeEntry({ name: "service-b" })]);

    const result = await catalogCommand({ kvStore: kv, repo: "repo-a", silent: true });

    expect(result.repoCount).toBe(1);
    expect(result.entities.has("repo-a")).toBe(true);
    expect(result.entities.has("repo-b")).toBe(false);
    expect(result.entities.get("repo-a")).toContain("service-a");
  });

  it("returns empty result when specified repo has no catalog data", async () => {
    const kv = new InMemoryKVStore();
    // No catalog keys at all

    const result = await catalogCommand({ kvStore: kv, repo: "nonexistent", silent: true });

    // repo name is found from explicit option; load returns empty array
    expect(result.entityCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// catalogCommand — --output dir writes files
// ---------------------------------------------------------------------------

describe("catalogCommand — --output dir", () => {
  beforeEach(() => {
    mockMkdir.mockClear();
    mockWriteFile.mockClear();
  });

  it("creates output dir and writes one file per repo", async () => {
    const kv = new InMemoryKVStore();
    await seedCatalog(kv, "repo-a", [makeEntry({ name: "service-a" })]);
    await seedCatalog(kv, "repo-b", [makeEntry({ name: "service-b" })]);

    const result = await catalogCommand({
      kvStore: kv,
      outputDir: "/tmp/catalog-out",
      silent: true,
    });

    expect(result.repoCount).toBe(2);
    expect(mockMkdir).toHaveBeenCalledWith("/tmp/catalog-out", { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledTimes(2);

    // Check that the file paths match the expected pattern
    const writtenPaths = mockWriteFile.mock.calls.map((call) => call[0] as string);
    expect(writtenPaths).toContain("/tmp/catalog-out/repo-a-catalog-info.yaml");
    expect(writtenPaths).toContain("/tmp/catalog-out/repo-b-catalog-info.yaml");
  });

  it("writes valid YAML content to each file", async () => {
    const kv = new InMemoryKVStore();
    await seedCatalog(kv, "my-repo", [makeEntry()]);

    await catalogCommand({
      kvStore: kv,
      outputDir: "/tmp/catalog-out",
      silent: true,
    });

    const yamlContent = mockWriteFile.mock.calls[0]![1] as string;
    expect(yamlContent).toContain("apiVersion: backstage.io/v1alpha1");
    expect(yamlContent).toContain("auth-service");
  });

  it("does not call writeFile when there are no catalog entries", async () => {
    const kv = new InMemoryKVStore();
    // Seed empty array
    await kv.set("catalog:empty-repo", JSON.stringify([]));

    await catalogCommand({
      kvStore: kv,
      outputDir: "/tmp/catalog-out",
      silent: true,
    });

    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});
