export { inferServices, buildArchitecture } from "./services.js";
export type { ServiceInferenceInput, PackageJsonInfo } from "./services.js";

export { detectPatterns } from "./patterns.js";
export type { PatternDetectionInput } from "./patterns.js";

export { scanForFlags } from "./flags.js";
export type { FlagScannerOptions } from "./flags.js";

export { extractLogStatements } from "./logs.js";
export type { DrainOptions } from "./logs.js";

export { analyzeNaming, splitIdentifier } from "./naming.js";

export { extractServiceTopology } from "./service-topology.js";
export type { ServiceTopologyInput } from "./service-topology.js";
