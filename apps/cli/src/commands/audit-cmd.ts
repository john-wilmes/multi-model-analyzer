/**
 * `mma audit` — parse npm audit JSON and check transitive vulnerability reachability.
 */

import { readFileSync } from "node:fs";
import type { KVStore, GraphStore } from "@mma/storage";
import {
  parseNpmAudit,
  checkTransitiveVulnReachability,
  vulnReachabilityToSarifWithCodeFlows,
} from "@mma/heuristics";

export interface AuditOptions {
  readonly auditFile?: string;
  readonly repo?: string;
  readonly kvStore: KVStore;
  readonly graphStore: GraphStore;
  readonly verbose?: boolean;
}

export async function auditCommand(options: AuditOptions): Promise<void> {
  const log = options.verbose ? console.log.bind(console) : () => {};

  // Read npm audit JSON from file or stdin
  let auditJson: string;
  if (options.auditFile) {
    auditJson = readFileSync(options.auditFile, "utf-8");
  } else {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk as Buffer);
    }
    auditJson = Buffer.concat(chunks).toString("utf-8");
  }

  const advisories = parseNpmAudit(auditJson);
  log(`Parsed ${advisories.length} advisories from npm audit`);

  if (advisories.length === 0) {
    console.log("No advisories found in audit output.");
    return;
  }

  // Get repo list from index
  const indexJson = await options.kvStore.get("sarif:latest:index");
  const repos = indexJson ? (JSON.parse(indexJson) as { repos: string[] }).repos : [];
  const targetRepos = options.repo ? [options.repo] : repos;

  if (targetRepos.length === 0) {
    console.log("No repos found. Run 'mma index' first.");
    return;
  }

  for (const repo of targetRepos) {
    const edges = await options.graphStore.getEdgesByKind("imports", repo);
    if (edges.length === 0) {
      log(`[${repo}] No import edges found, skipping`);
      continue;
    }

    // Build match entries: advisories paired with placeholder packages
    // (npm audit already verified version ranges — we just need reachability)
    const matches = advisories.map((a) => ({
      pkg: { name: a.package, version: "0.0.0" },
      advisory: a,
    }));

    const reachability = checkTransitiveVulnReachability(matches, edges);
    const sarif = vulnReachabilityToSarifWithCodeFlows(reachability, repo);

    if (sarif.length > 0) {
      await options.kvStore.set(`sarif:vuln:${repo}`, JSON.stringify(sarif));
      console.log(`[${repo}] ${sarif.length} reachable vulnerabilities found`);
      for (const r of sarif) {
        console.log(`  ${r.level}: ${r.message.text}`);
      }
    } else {
      console.log(`[${repo}] No reachable vulnerabilities`);
    }
  }
}
