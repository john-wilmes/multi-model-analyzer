import type { ValidateResult } from "./reporter.js";

// ─── Output formatting ────────────────────────────────────

export function formatTable(result: ValidateResult): string {
  const lines: string[] = [];
  lines.push("Validation Summary");
  lines.push("==================");
  lines.push("");

  // Per-rule table
  lines.push("Rule                Pass  Fail  Skip");
  lines.push("──────────────────  ────  ────  ────");
  for (const c of result.checks) {
    const rule = c.rule.padEnd(18);
    const pass = String(c.pass).padStart(4);
    const fail = String(c.fail).padStart(4);
    const skip = String(c.skip).padStart(4);
    lines.push(`${rule}  ${pass}  ${fail}  ${skip}`);
  }
  lines.push("");

  // Summary
  const { pass, fail, skip, total } = result.summary;
  lines.push(`Total: ${total}  Pass: ${pass}  Fail: ${fail}  Skip: ${skip}`);

  // Failures
  if (result.failures.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const f of result.failures) {
      const prefix = `  [${f.category}] ${f.repo}`;
      lines.push(`${prefix}: ${f.label}${f.detail ? ` — ${f.detail}` : ""}`);
    }
  }

  return lines.join("\n");
}

export function formatMarkdown(result: ValidateResult): string {
  const lines: string[] = [];
  lines.push("## Validation Summary");
  lines.push("");

  lines.push("| Rule | Pass | Fail | Skip |");
  lines.push("|------|------|------|------|");
  for (const c of result.checks) {
    lines.push(`| ${c.rule} | ${c.pass} | ${c.fail} | ${c.skip} |`);
  }
  lines.push("");

  const { pass, fail, skip, total } = result.summary;
  lines.push(`**Total:** ${total} — Pass: ${pass}, Fail: ${fail}, Skip: ${skip}`);

  if (result.failures.length > 0) {
    lines.push("");
    lines.push("### Failures");
    lines.push("");
    lines.push("| Category | Repo | Label | Detail |");
    lines.push("|----------|------|-------|--------|");
    for (const f of result.failures) {
      lines.push(`| ${f.category} | ${f.repo} | ${f.label} | ${f.detail ?? ""} |`);
    }
  }

  return lines.join("\n");
}
