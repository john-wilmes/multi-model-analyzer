/**
 * Language-agnostic file classification for the parsing layer.
 *
 * Determines FileKind from file path/extension.
 */

import type { FileKind } from "@mma/core";

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

export function isParseable(kind: FileKind): boolean {
  return kind === "typescript" || kind === "javascript";
}
