import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { KVStore } from "@mma/storage";
import type { SarifLog, DetectedPattern, ModuleMetrics, RepoMetricsSummary } from "@mma/core";

export function registerResources(server: McpServer, kvStore: KVStore): void {
  // Static resource: list of all indexed repos
  server.resource("repos", "mma://repos", {
    description: "List of all indexed repositories and their available data",
  }, async () => {
    const repoSet = new Set<string>();
    for (const prefix of ["metrics:", "patterns:", "docs:functional:"]) {
      const keys = await kvStore.keys(prefix);
      for (const key of keys) {
        if (prefix === "metrics:" && key.startsWith("metricsSummary:")) continue;
        repoSet.add(key.slice(prefix.length));
      }
    }
    const repos = [...repoSet].sort();
    return {
      contents: [{
        uri: "mma://repos",
        mimeType: "application/json",
        text: JSON.stringify({ total: repos.length, repos }, null, 2),
      }],
    };
  });

  // Resource template: findings per repo
  server.resource("repo-findings", new ResourceTemplate("mma://repo/{name}/findings", {
    list: async () => {
      const keys = await kvStore.keys("metrics:");
      const repos = keys
        .filter((k) => !k.startsWith("metricsSummary:"))
        .map((k) => k.replace("metrics:", ""));
      return { resources: repos.map((r) => ({
        uri: `mma://repo/${r}/findings`,
        name: `${r} findings`,
        description: `SARIF diagnostic findings for ${r}`,
      })) };
    },
  }), {
    description: "SARIF diagnostic findings for a specific repository",
  }, async (uri, { name }) => {
    const repo = name as string;
    const sarifJson = await kvStore.get("sarif:latest");
    if (!sarifJson) {
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "No analysis results. Run 'mma index' first." }) }] };
    }

    let sarif: SarifLog;
    try {
      sarif = JSON.parse(sarifJson) as SarifLog;
    } catch {
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: "Corrupted SARIF data." }) }] };
    }

    const results = sarif.runs.flatMap((r) =>
      r.results.filter((res) => {
        const locRepo = res.locations?.[0]?.logicalLocations?.[0]?.properties?.["repo"];
        return locRepo === repo;
      }),
    );

    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ repo, total: results.length, results }, null, 2),
      }],
    };
  });

  // Resource template: metrics per repo
  server.resource("repo-metrics", new ResourceTemplate("mma://repo/{name}/metrics", {
    list: async () => {
      const keys = await kvStore.keys("metrics:");
      const repos = keys
        .filter((k) => !k.startsWith("metricsSummary:"))
        .map((k) => k.replace("metrics:", ""));
      return { resources: repos.map((r) => ({
        uri: `mma://repo/${r}/metrics`,
        name: `${r} metrics`,
        description: `Module instability metrics for ${r}`,
      })) };
    },
  }), {
    description: "Module instability metrics for a specific repository",
  }, async (uri, { name }) => {
    const repo = name as string;
    const json = await kvStore.get(`metrics:${repo}`);
    if (!json) {
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: `No metrics for repo '${repo}'.` }) }] };
    }

    const modules = JSON.parse(json) as ModuleMetrics[];
    const summaryJson = await kvStore.get(`metricsSummary:${repo}`);
    const summary = summaryJson ? (JSON.parse(summaryJson) as RepoMetricsSummary) : undefined;

    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ repo, moduleCount: modules.length, summary, modules }, null, 2),
      }],
    };
  });

  // Resource template: patterns per repo
  server.resource("repo-patterns", new ResourceTemplate("mma://repo/{name}/patterns", {
    list: async () => {
      const keys = await kvStore.keys("patterns:");
      return { resources: keys.map((k) => {
        const r = k.replace("patterns:", "");
        return {
          uri: `mma://repo/${r}/patterns`,
          name: `${r} patterns`,
          description: `Detected design patterns in ${r}`,
        };
      }) };
    },
  }), {
    description: "Detected design patterns for a specific repository",
  }, async (uri, { name }) => {
    const repo = name as string;
    const json = await kvStore.get(`patterns:${repo}`);
    if (!json) {
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify({ error: `No patterns for repo '${repo}'.` }) }] };
    }

    const patterns = JSON.parse(json) as DetectedPattern[];
    return {
      contents: [{
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify({ repo, total: patterns.length, patterns }, null, 2),
      }],
    };
  });
}
