import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import type { RepoConfig, ArchitecturalRule, CustomQueueFramework, FlagDefaults } from "@mma/core";
import type { StorageBackend } from "@mma/storage";
import { validateArchRules } from "@mma/heuristics";
import type { RawArchRule, Advisory } from "@mma/heuristics";

export interface CliConfig {
  readonly repos: readonly RepoConfig[];
  readonly mirrorDir: string;
  readonly dbPath?: string;
  readonly rules?: readonly RawArchRule[];
  readonly baselinePath?: string;
  readonly backend?: StorageBackend;
  readonly advisories?: readonly Advisory[];
  readonly llmProvider?: "anthropic" | "openai" | "ollama";
  readonly llmApiKey?: string;
  readonly llmModel?: string;
  readonly customQueueFrameworks?: readonly CustomQueueFramework[];
  readonly flagDefaults?: FlagDefaults;
}

/**
 * Resolve the DB path from CLI flags and/or config file (sync, no config parse needed).
 * Used by commands that don't load a full config.
 */
export function resolveDbPath(
  dbFlag: string | undefined,
  configFlag: string | undefined,
): string {
  if (dbFlag) {
    return dbFlag === ":memory:" ? ":memory:" : resolve(dbFlag);
  }
  if (configFlag) {
    try {
      const cfgRaw = JSON.parse(readFileSync(resolve(configFlag), "utf-8"));
      if (cfgRaw.dbPath) {
        return cfgRaw.dbPath === ":memory:"
          ? ":memory:"
          : resolve(dirname(resolve(configFlag)), cfgRaw.dbPath);
      }
    } catch {
      // fall through to default
    }
  }
  return resolve("data", "mma.db");
}

/**
 * Resolve the storage backend from a CLI flag value and optional config.
 * Returns "sqlite" or "kuzu".
 */
export function resolveEarlyBackend(backendFlag: string | undefined): StorageBackend {
  return backendFlag === "kuzu" ? "kuzu" : "sqlite";
}

/**
 * Validate a raw `customQueueFrameworks` value from a config file or serve request.
 * Exits with an error message on invalid input; returns the validated array on success.
 * Accepts `undefined` and returns `undefined` (no frameworks configured).
 */
export function validateCustomQueueFrameworks(
  value: unknown,
): readonly CustomQueueFramework[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    console.error(`Config field "customQueueFrameworks" must be an array`);
    process.exit(1);
  }
  for (let i = 0; i < (value as unknown[]).length; i++) {
    const fw = (value as unknown[])[i];
    if (typeof fw !== "object" || fw === null || Array.isArray(fw)) {
      console.error(`Config field "customQueueFrameworks[${i}]" must be an object`);
      process.exit(1);
    }
    const fwObj = fw as Record<string, unknown>;
    if (typeof fwObj["importTrigger"] !== "string" || fwObj["importTrigger"].trim() === "") {
      console.error(`Config field "customQueueFrameworks[${i}].importTrigger" must be a non-empty string`);
      process.exit(1);
    }
    if (fwObj["consumers"] !== undefined && !Array.isArray(fwObj["consumers"])) {
      console.error(`Config field "customQueueFrameworks[${i}].consumers" must be an array`);
      process.exit(1);
    }
    if (fwObj["producers"] !== undefined && !Array.isArray(fwObj["producers"])) {
      console.error(`Config field "customQueueFrameworks[${i}].producers" must be an array`);
      process.exit(1);
    }
  }
  return value as readonly CustomQueueFramework[];
}

/**
 * Validate a raw `flagDefaults` value from a config file.
 * Exits with an error message on invalid input; returns the validated object on success.
 * Accepts `undefined` and returns `undefined` (no defaults configured).
 */
export function validateFlagDefaults(value: unknown): FlagDefaults | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error(`Config field "flagDefaults" must be an object`);
    process.exit(1);
  }
  const obj = value as Record<string, unknown>;
  const arrayOfStringsFields = ["sdkImports", "sdkMethods", "hookPatterns", "rolloutCallMethods"] as const;
  for (const field of arrayOfStringsFields) {
    if (obj[field] !== undefined) {
      if (!Array.isArray(obj[field])) {
        console.error(`Config field "flagDefaults.${field}" must be an array`);
        process.exit(1);
      }
      for (let i = 0; i < (obj[field] as unknown[]).length; i++) {
        if (typeof (obj[field] as unknown[])[i] !== "string") {
          console.error(`Config field "flagDefaults.${field}[${i}]" must be a string`);
          process.exit(1);
        }
      }
    }
  }
  const stringFields = ["flagPropertyName", "registryEnumName"] as const;
  for (const field of stringFields) {
    if (obj[field] !== undefined && typeof obj[field] !== "string") {
      console.error(`Config field "flagDefaults.${field}" must be a string`);
      process.exit(1);
    }
  }
  return obj as FlagDefaults;
}

/**
 * Load and validate a full CliConfig from the config file path.
 * Resolves all paths relative to the config file directory.
 * Exits with error on missing/invalid required fields.
 */
export async function loadConfig(
  configFlag: string,
  dbFlag: string | undefined,
  backendFlag: string | undefined,
  verbose: boolean,
): Promise<{
  config: CliConfig;
  configPath: string;
  configDir: string;
  dbPath: string;
  backend: StorageBackend;
  validatedRules: ArchitecturalRule[];
}> {
  const configPath = resolve(configFlag);
  let config: CliConfig;

  try {
    const raw = await readFile(configPath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (jsonErr) {
      console.error(`Could not parse config file: ${configPath}`);
      console.error(`  JSON error: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`);
      process.exit(1);
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      console.error(`Config file must be a JSON object: ${configPath}`);
      process.exit(1);
    }

    const cfg = parsed as Record<string, unknown>;
    if (!Array.isArray(cfg["repos"])) {
      console.error(`Config missing required field: "repos" (must be an array)`);
      process.exit(1);
    }
    if (typeof cfg["mirrorDir"] !== "string") {
      console.error(`Config missing required field: "mirrorDir" (must be a string)`);
      process.exit(1);
    }

    // Warn on unknown top-level fields (catches typos)
    const knownFields = new Set([
      "repos", "mirrorDir", "dbPath", "rules", "baselinePath",
      "backend", "advisories", "llmProvider", "llmApiKey", "llmModel",
      "customQueueFrameworks", "flagDefaults",
    ]);
    for (const key of Object.keys(cfg)) {
      if (!knownFields.has(key)) {
        console.error(`warning: unknown config field "${key}" — possible typo`);
      }
    }

    // Validate customQueueFrameworks if present
    if (cfg["customQueueFrameworks"] !== undefined) {
      validateCustomQueueFrameworks(cfg["customQueueFrameworks"]);
    }

    // Validate flagDefaults if present
    if (cfg["flagDefaults"] !== undefined) {
      validateFlagDefaults(cfg["flagDefaults"]);
    }

    config = cfg as unknown as CliConfig;

    // Expand ${ENV_VAR} references in llmApiKey
    if (typeof config.llmApiKey === "string" && config.llmApiKey.includes("${")) {
      const expanded = config.llmApiKey.replace(
        /\$\{(\w+)\}/g,
        (_, name) => process.env[name] ?? "",
      );
      config = { ...config, llmApiKey: expanded };
    }
  } catch {
    console.error(`Could not read config file: ${configPath}`);
    console.error("Create an mma.config.json with repos and mirrorDir.");
    process.exit(1);
  }

  // Resolve all paths relative to the config file's directory
  const configDir = dirname(configPath);
  config = {
    ...config,
    mirrorDir: resolve(configDir, config.mirrorDir),
    repos: config.repos.map((r) => ({
      ...r,
      localPath: r.localPath !== undefined ? resolve(configDir, r.localPath) : undefined,
    })),
  };

  // Resolve dbPath: --db flag > config.dbPath > default data/mma.db
  let dbPath: string;
  if (dbFlag) {
    dbPath = dbFlag === ":memory:" ? ":memory:" : resolve(dbFlag);
  } else if (config.dbPath) {
    dbPath = config.dbPath === ":memory:" ? ":memory:" : resolve(configDir, config.dbPath);
  } else {
    dbPath = resolve("data", "mma.db");
  }

  // Resolve backend: --backend flag > config.backend > "sqlite"
  const rawBackend = backendFlag ?? config.backend ?? "sqlite";
  if (rawBackend !== "sqlite" && rawBackend !== "kuzu") {
    console.error(`Invalid --backend: "${rawBackend}". Must be "sqlite" or "kuzu".`);
    process.exit(1);
  }
  const backend: StorageBackend = rawBackend;

  // Validate architectural rules
  let validatedRules: ArchitecturalRule[] = [];
  if (config.rules && config.rules.length > 0) {
    const { rules, errors } = validateArchRules(config.rules);
    validatedRules = rules;
    for (const err of errors) {
      console.error(`  warning: rules[${err.ruleIndex}].${err.field}: ${err.message}`);
    }
    if (verbose && rules.length > 0) {
      console.error(`  Loaded ${rules.length} architectural rule(s)`);
    }
  }

  return { config, configPath, configDir, dbPath, backend, validatedRules };
}
