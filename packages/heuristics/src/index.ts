export { inferServices, inferServicesWithMeta, buildArchitecture } from "./services.js";
export type { ServiceInferenceInput, PackageJsonInfo } from "./services.js";

export { detectPatterns, detectPatternsWithMeta } from "./patterns.js";
export type { PatternDetectionInput } from "./patterns.js";

export { scanForFlags } from "./flags.js";
export type { FlagScannerOptions } from "./flags.js";

export { extractLogStatements } from "./logs.js";
export type { DrainOptions } from "./logs.js";

export { analyzeNaming, analyzeNamingWithMeta, splitIdentifier } from "./naming.js";

export { extractServiceTopology } from "./service-topology.js";
export type { ServiceTopologyInput, ServiceCallEdge } from "./service-topology.js";

export { evaluateArchRules, globMatch } from "./arch-rules.js";

export { validateArchRules, ARCH_RULES_JSON_SCHEMA } from "./arch-rules-schema.js";
export type { RawArchRule, ValidationError } from "./arch-rules-schema.js";

export { detectTemporalCoupling, detectTemporalCouplingWithMeta, temporalCouplingToSarif, groupByCommit } from "./temporal-coupling.js";
export type { CommitInfo, CoupledPair, TemporalCouplingOptions, TemporalCouplingResult } from "./temporal-coupling.js";

export { withinWindow, extractPairs } from "./git-history.js";
export type { CoChangePair } from "./git-history.js";

export { isVulnerable, matchAdvisories, checkVulnReachability, vulnReachabilityToSarif } from "./vuln-match.js";
export type { Advisory, InstalledPackage, VulnReachabilityResult } from "./vuln-match.js";

export { computeHotspots } from "./hotspots.js";
export type { FileHotspot, HotspotResult, CommitFileChange as HotspotCommitFileChange } from "./hotspots.js";
