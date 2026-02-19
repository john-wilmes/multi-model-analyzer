/**
 * SWUM-style naming convention analysis.
 *
 * Software Word Usage Model (SWUM) splits identifiers into words
 * and extracts verb-object patterns to infer method purposes.
 *
 * "getUserById" -> verb: "get", object: "user", qualifier: "by id"
 * "validateEmailFormat" -> verb: "validate", object: "email format"
 */

import type { MethodPurpose, MethodPurposeMap, SymbolInfo } from "@mma/core";

const ACTION_VERBS = new Set([
  "get", "set", "create", "delete", "remove", "update", "add", "find",
  "fetch", "load", "save", "send", "receive", "parse", "validate",
  "check", "is", "has", "can", "should", "handle", "process",
  "transform", "convert", "map", "filter", "reduce", "sort",
  "build", "make", "render", "display", "show", "hide",
  "init", "initialize", "start", "stop", "reset", "clear",
  "open", "close", "connect", "disconnect",
  "read", "write", "append", "insert",
  "enable", "disable", "toggle",
  "subscribe", "unsubscribe", "publish", "emit",
  "register", "unregister", "bind", "unbind",
  "serialize", "deserialize", "encode", "decode",
  "encrypt", "decrypt", "hash", "sign", "verify",
  "log", "debug", "warn", "error", "trace",
  "retry", "poll", "schedule", "queue", "dispatch",
  "merge", "split", "join", "concat",
  "format", "normalize", "sanitize", "escape",
  "resolve", "reject", "await",
  "throw", "catch",
  "test", "assert", "expect", "mock",
]);

export function analyzeNaming(
  files: ReadonlyMap<string, readonly SymbolInfo[]>,
  repo: string,
): MethodPurposeMap {
  const methods: MethodPurpose[] = [];

  for (const [filePath, symbols] of files) {
    const fnSymbols = symbols.filter(
      (s) => s.kind === "function" || s.kind === "method",
    );

    for (const sym of fnSymbols) {
      const words = splitIdentifier(sym.name);
      if (words.length === 0) continue;

      const purpose = inferPurpose(words);
      if (purpose) {
        methods.push({
          methodId: sym.containerName
            ? `${filePath}#${sym.containerName}.${sym.name}`
            : `${filePath}#${sym.name}`,
          verb: purpose.verb,
          object: purpose.object,
          purpose: purpose.description,
          confidence: purpose.confidence,
        });
      }
    }
  }

  return { repo, methods };
}

interface PurposeResult {
  verb: string;
  object: string;
  description: string;
  confidence: number;
}

function inferPurpose(words: string[]): PurposeResult | null {
  if (words.length === 0) return null;

  const firstWord = words[0]!.toLowerCase();

  // Predicate pattern: isValid, hasPermission, canEdit
  // Checked before ACTION_VERBS since these produce more specific results
  if (firstWord === "is" || firstWord === "has" || firstWord === "can" || firstWord === "should") {
    const predicate = words.slice(1).join(" ").toLowerCase();
    return {
      verb: "check",
      object: predicate,
      description: `Checks whether ${predicate}`,
      confidence: 0.8,
    };
  }

  // Event handler pattern: onSubmit, handleClick
  if (firstWord === "on" || firstWord === "handle") {
    const event = words.slice(1).join(" ").toLowerCase();
    return {
      verb: "handle",
      object: `${event} event`,
      description: `Handles ${event} event`,
      confidence: 0.75,
    };
  }

  // Standard verb-object pattern: getUser, createOrder
  if (ACTION_VERBS.has(firstWord)) {
    const object = words.slice(1).join(" ").toLowerCase();
    return {
      verb: firstWord,
      object: object || "unknown",
      description: `${capitalize(firstWord)}s ${object || "something"}`,
      confidence: object ? 0.85 : 0.5,
    };
  }

  // Noun-only: probably a getter or constructor
  if (words.length >= 2) {
    return {
      verb: "compute",
      object: words.join(" ").toLowerCase(),
      description: `Computes or returns ${words.join(" ").toLowerCase()}`,
      confidence: 0.4,
    };
  }

  return null;
}

export function splitIdentifier(name: string): string[] {
  // Handle camelCase and PascalCase
  const withSpaces = name
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");

  // Handle snake_case and kebab-case
  const words = withSpaces
    .split(/[\s_\-]+/)
    .filter(Boolean);

  return words;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}
