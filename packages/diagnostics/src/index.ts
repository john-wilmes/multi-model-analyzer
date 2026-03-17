export { SarifEmitter } from "./sarif-emitter.js";
export type { EmitterOptions } from "./sarif-emitter.js";

export { redactSarifLog, hashToken } from "./redaction.js";
export type { RedactionOptions } from "./redaction.js";

export { aggregateSarifLogs, aggregateRuns, sarifToJson } from "./aggregation.js";

export { computeBaseline, fingerprint } from "./baseline.js";
export type { BaselineResult } from "./baseline.js";

export { hotspotFindings } from "./sarif-hotspot.js";
export type { HotspotEntry } from "./sarif-hotspot.js";

export { computeRepoAtdi, computeSystemAtdi } from "./atdi.js";
export type { AtdiScore, SystemAtdi } from "./atdi.js";
