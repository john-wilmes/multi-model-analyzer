/**
 * Tier 1 summarization: template-based descriptions from AST.
 *
 * Free, instant, always runs. Produces method signature descriptions.
 * Example: "Accepts (patientId: string, date: Date), returns Promise<Appointment[]>"
 */

import type { Summary, SymbolInfo } from "@mma/core";

export function summarizeFromTemplate(
  symbol: SymbolInfo,
  filePath: string,
  sourceText: string,
): Summary {
  const entityId = symbol.containerName
    ? `${filePath}#${symbol.containerName}.${symbol.name}`
    : `${filePath}#${symbol.name}`;

  const description = buildTemplateDescription(symbol, sourceText);

  return {
    entityId,
    tier: 1,
    description,
    confidence: 0.6,
  };
}

function buildTemplateDescription(
  symbol: SymbolInfo,
  sourceText: string,
): string {
  const lines = sourceText.split("\n");
  const signatureLine = lines[symbol.startLine - 1] ?? "";

  switch (symbol.kind) {
    case "function":
    case "method": {
      const params = extractParams(signatureLine);
      const returnType = extractReturnType(signatureLine);
      const parts: string[] = [];
      if (params) parts.push(`Accepts (${params})`);
      if (returnType) parts.push(`returns ${returnType}`);
      return parts.length > 0
        ? parts.join(", ")
        : `${symbol.kind} ${symbol.name}`;
    }
    case "class":
      return `Class ${symbol.name} (lines ${symbol.startLine}-${symbol.endLine})`;
    case "interface":
      return `Interface ${symbol.name}`;
    case "type":
      return `Type alias ${symbol.name}`;
    case "enum":
      return `Enum ${symbol.name}`;
    case "variable":
      return `Variable ${symbol.name}`;
    default:
      return `${symbol.kind} ${symbol.name}`;
  }
}

function extractParams(line: string): string | null {
  // This regex matches the first balanced pair of parens but does not handle
  // nested parentheses in parameter types (e.g. callback: (err: Error) => void).
  // For such signatures the extracted text will be truncated at the first ")".
  const match = /\(([^)]*)\)/.exec(line);
  return match?.[1]?.trim() || null;
}

function extractReturnType(line: string): string | null {
  const match = /\):\s*(.+?)\s*[{;]/.exec(line);
  return match?.[1]?.trim() || null;
}

export function tier1Summarize(
  symbols: readonly SymbolInfo[],
  filePath: string,
  sourceText: string,
): Summary[] {
  return symbols
    .filter((s) => s.kind === "function" || s.kind === "method" || s.kind === "class")
    .map((s) => summarizeFromTemplate(s, filePath, sourceText));
}
