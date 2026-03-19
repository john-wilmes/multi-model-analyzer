/**
 * Language-agnostic file classification shared across ingestion and parsing.
 *
 * Lives in @mma/core so both @mma/ingestion and @mma/parsing can use it
 * without introducing a cross-layer dependency.
 */

import type { FileKind } from "./types.js";

export function classifyFileKind(filePath: string): FileKind {
  const lower = filePath.toLowerCase();
  const ext = lower.split(".").pop();

  switch (ext) {
    case "ts":
    case "tsx":
    case "mts":
    case "cts":
      return "typescript";
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return "javascript";
    case "json":
      return "json";
    case "yml":
    case "yaml":
      return "yaml";
    case "md":
    case "mdx":
      return "markdown";
    default:
      break;
  }

  if (/[Dd]ockerfile/.test(filePath)) return "dockerfile";
  if (lower.includes("k8s") || lower.includes("kubernetes")) return "kubernetes";

  return "unknown";
}
