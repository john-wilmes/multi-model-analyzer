import { parseArgs as nodeParseArgs } from "node:util";

export type ParsedArgs = ReturnType<typeof parseCliArgs>;

export function parseCliArgs() {
  return nodeParseArgs({
    allowPositionals: true,
    options: {
      config: { type: "string", short: "c", default: "mma.config.json" },
      verbose: { type: "boolean", short: "v", default: false },
      help: { type: "boolean", short: "h", default: false },
      db: { type: "string" },
      affected: { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      format: { type: "string" },
      "include-sarif": { type: "boolean", default: false },
      salt: { type: "string", default: "" },
      note: { type: "string" },
      mirrors: { type: "string" },
      "sample-size": { type: "string", default: "50" },
      seed: { type: "string", default: "42" },
      version: { type: "boolean", default: false },
      watch: { type: "boolean", short: "w", default: false },
      "watch-interval": { type: "string", default: "30" },
      raw: { type: "boolean", default: false },
      baseline: { type: "string" },
      "max-api-calls": { type: "string" },
      "force-full-reindex": { type: "boolean", default: false },
      enrich: { type: "boolean", default: false },
      "ollama-url": { type: "string" },
      "ollama-model": { type: "string" },
      "llm-provider": { type: "string" },
      "llm-api-key": { type: "string" },
      "llm-model": { type: "string" },
      port: { type: "string", default: "3000" },
      host: { type: "string", default: "127.0.0.1" },
      "cors-origin": { type: "string", multiple: true },
      backend: { type: "string" },
      transport: { type: "string" },
      "exit-code": { type: "boolean", default: false },
      repo: { type: "string" },
      "max-depth": { type: "string", default: "5" },
      "audit-file": { type: "string" },
      concurrency: { type: "string" },
      language: { type: "string" },
      "batch-size": { type: "string" },
    },
  });
}
