/**
 * Log root identification for fault tree construction.
 *
 * Each log.error/log.warn statement is a potential "top event" in a fault tree.
 * This module identifies them and classifies by severity and context.
 */

import type { LogTemplate, LogTemplateIndex, LogicalLocation } from "@mma/core";

export interface LogRoot {
  readonly id: string;
  readonly template: LogTemplate;
  readonly severity: "critical" | "high" | "medium" | "low";
  readonly context: string;
  readonly location: LogicalLocation;
}

export function identifyLogRoots(
  logIndex: LogTemplateIndex,
): LogRoot[] {
  const roots: LogRoot[] = [];

  for (const template of logIndex.templates) {
    if (template.severity !== "error" && template.severity !== "warn") continue;

    const severity = classifySeverity(template);
    const context = inferContext(template);

    for (const location of template.locations) {
      roots.push({
        id: `${template.id}:${location.fullyQualifiedName ?? location.module}`,
        template,
        severity,
        context,
        location,
      });
    }
  }

  return roots.sort((a, b) => severityOrder(a.severity) - severityOrder(b.severity));
}

function classifySeverity(template: LogTemplate): LogRoot["severity"] {
  const text = template.template.toLowerCase();

  if (
    text.includes("fatal") ||
    text.includes("crash") ||
    text.includes("unrecoverable") ||
    text.includes("data loss")
  ) {
    return "critical";
  }

  if (
    text.includes("failed") ||
    text.includes("error") ||
    text.includes("exception") ||
    text.includes("timeout")
  ) {
    return "high";
  }

  if (
    text.includes("warn") ||
    text.includes("deprecated") ||
    text.includes("retry")
  ) {
    return "medium";
  }

  return "low";
}

function inferContext(template: LogTemplate): string {
  const text = template.template.toLowerCase();

  if (text.includes("database") || text.includes("query") || text.includes("sql")) {
    return "database";
  }
  if (text.includes("http") || text.includes("request") || text.includes("api")) {
    return "network";
  }
  if (text.includes("auth") || text.includes("token") || text.includes("permission")) {
    return "authentication";
  }
  if (text.includes("file") || text.includes("disk") || text.includes("io")) {
    return "filesystem";
  }
  if (text.includes("memory") || text.includes("heap") || text.includes("gc")) {
    return "memory";
  }

  return "general";
}

function severityOrder(severity: LogRoot["severity"]): number {
  switch (severity) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
  }
}
