export interface FlagAssertion {
  repo: string;
  flagName: string;
  file?: string;
  note: string;
}

export interface FaultAssertion {
  repo: string;
  kind: "logger.error" | "logger.warn" | "throw" | "console.error";
  signature: string;
  file?: string;
  note: string;
}

export interface ServiceAssertion {
  repo: string;
  serviceNameSubstring: string;
  note: string;
}
