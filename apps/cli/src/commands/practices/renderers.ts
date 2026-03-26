/**
 * Renderers for the `mma practices` command.
 *
 * Provides markdown and terminal table output for a PracticesReport.
 */

import { formatTable } from "../../formatter.js";
import type {
  PracticesReport,
  FindingGroup,
} from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ratingIcon(rating: string): string {
  if (rating === "good") return "✅";
  if (rating === "warning") return "⚠️";
  return "🔴";
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

export function renderPracticesMarkdown(report: PracticesReport): string {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push("# Best Practices Report", "");
  push(
    `Generated: ${report.generatedAt} | Repos: ${report.repoCount}`,
    "",
  );

  // --- Executive Summary ---
  push("## Executive Summary", "");
  push(`**Grade: ${report.executive.grade}** (${report.executive.score}/100)`, "");
  push(report.executive.headline, "");

  if (report.executive.topActions.length > 0) {
    push("### Top Actions");
    report.executive.topActions.forEach((a, i) => push(`${i + 1}. ${a}`));
    push("");
  }

  // --- Technical Debt Index ---
  push("## Technical Debt Index", "");
  push(`**ATDI: ${report.atdi.score}/100** (${report.atdi.trend})`, "");
  push(`New findings: ${report.atdi.newFindingCount} | Total: ${report.atdi.totalFindingCount}`, "");
  if (report.atdi.categoryBreakdown.length > 0) {
    push("| Category | Contribution | Density |");
    push("|----------|-------------|---------|");
    for (const row of report.atdi.categoryBreakdown) {
      push(`| ${row.category} | ${row.contribution} | ${row.findingDensity} |`);
    }
    push("");
  }

  // --- Estimated Remediation Cost ---
  push("## Estimated Remediation Cost", "");
  if (report.debt.totalDebtMinutes > 0) {
    const days = Math.round((report.debt.totalDebtHours / 6) * 10) / 10;
    push(`**Total: ${report.debt.totalDebtHours} hours** (${days} days at 6h/day)`, "");
    if (report.debt.byCategory.length > 0) {
      push("| Category | Hours | Findings | Avg/Finding |");
      push("|----------|-------|----------|-------------|");
      for (const cat of report.debt.byCategory) {
        const avgMin = (cat.debtMinutes / cat.findingCount).toFixed(0);
        push(`| ${cat.category} | ${cat.debtHours}h | ${cat.findingCount} | ${avgMin}m |`);
      }
      push("");
    }
    if (report.debt.byRule.length > 0) {
      push("Top contributors:");
      push("| Rule | Count | Per Instance | Total |");
      push("|------|-------|--------------|-------|");
      for (const r of report.debt.byRule) {
        const totalHours = (r.totalMinutes / 60).toFixed(1);
        push(`| \`${r.ruleId}\` | ${r.findingCount} | ${r.minutesPerInstance}m | ${r.totalMinutes}m (${totalHours}h) |`);
      }
      push("");
    }
  } else {
    push("No findings — zero estimated remediation cost.", "");
  }

  // --- Priority Findings ---
  push("## Priority Findings", "");

  const findingTable = (groups: readonly FindingGroup[]) => {
    push("| Rule | Category | Count | New? | Action |");
    push("|------|----------|-------|------|--------|");
    for (const g of groups) {
      const newMark = g.hasNew ? "yes" : "";
      const action = g.action.replace(/\|/g, "\\|");
      push(`| \`${g.ruleId}\` | ${g.category} | ${g.count} | ${newMark} | ${action} |`);
    }
    push("");
  };

  push("### 🔴 Fix Now");
  if (report.findings.fixNow.length > 0) {
    findingTable(report.findings.fixNow);
  } else {
    push("No critical findings.", "");
  }

  push("### 🟡 Plan For");
  if (report.findings.planFor.length > 0) {
    findingTable(report.findings.planFor);
  } else {
    push("No medium-priority findings.", "");
  }

  push("### 🟢 Monitor");
  if (report.findings.monitor.length > 0) {
    findingTable(report.findings.monitor);
  } else {
    push("No low-priority findings.", "");
  }

  // --- Structural Health ---
  push("## Structural Health", "");
  if (report.structural.repos.length > 0) {
    push(
      "| Repo | Modules | Dist. from Main Seq. | Pain Zone % | Uselessness % |",
    );
    push("|------|---------|---------------------|-------------|---------------|");
    for (const r of report.structural.repos) {
      const distCell = `${r.avgDistance} ${ratingIcon(r.distanceRating)}`;
      const painCell = `${r.painZonePct}% ${ratingIcon(r.painRating)}`;
      const uselessCell = `${r.uselessnessPct}% ${ratingIcon(r.uselessnessRating)}`;
      push(
        `| ${r.repo} | ${r.moduleCount} | ${distCell} | ${painCell} | ${uselessCell} |`,
      );
    }
    push("");
  } else {
    push("No structural metrics available.", "");
  }

  // --- Category Scorecard ---
  push("## Category Scorecard", "");
  if (report.scorecard.length > 0) {
    push("| Category | Health | Errors | Warnings | Notes | Total |");
    push("|----------|--------|--------|----------|-------|-------|");
    for (const row of report.scorecard) {
      push(
        `| ${row.category} | ${row.stars} | ${row.errorCount} | ${row.warningCount} | ${row.noteCount} | ${row.total} |`,
      );
    }
    push("");
  } else {
    push("No findings to score.", "");
  }

  // --- Recommendations ---
  push("## Recommendations", "");
  if (report.recommendations.length > 0) {
    for (const rec of report.recommendations) {
      push(`${rec.priority}. **${rec.title}** (Effort: ${rec.effort})`);
      push(`   ${rec.rationale}`);
      if (rec.guideRef) push(`   📖 ${rec.guideRef}`);
      push("");
    }
  } else {
    push("No specific recommendations at this time.", "");
  }

  push("---");
  push("*See docs/findings-guide.md for detailed rule documentation.*");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Terminal table renderer
// ---------------------------------------------------------------------------

export function renderPracticesTable(report: PracticesReport): string {
  const lines: string[] = [];
  const push = (...s: string[]) => lines.push(...s);

  push(
    `Practices Report — Grade: ${report.executive.grade} (${report.executive.score}/100) — ${report.repoCount} repo(s)`,
  );
  push(report.executive.headline);
  push(`ATDI: ${report.atdi.score}/100 (${report.atdi.trend})`);
  const debtDays = Math.round((report.debt.totalDebtHours / 6) * 10) / 10;
  push(`Estimated Debt: ${report.debt.totalDebtHours} hours (${debtDays} days at 6h/day)`);
  push("");

  // Scorecard table
  if (report.scorecard.length > 0) {
    push("Category Scorecard:");
    push(
      formatTable(
        ["Category", "Health", "Errors", "Warnings", "Notes", "Total"],
        report.scorecard.map((r) => [
          r.category,
          r.stars,
          String(r.errorCount),
          String(r.warningCount),
          String(r.noteCount),
          String(r.total),
        ]),
      ),
    );
    push("");
  }

  // Top 5 findings
  const allFindings = [
    ...report.findings.fixNow,
    ...report.findings.planFor,
    ...report.findings.monitor,
  ].slice(0, 5);

  if (allFindings.length > 0) {
    push("Top Findings:");
    push(
      formatTable(
        ["Rule", "Category", "Level", "Count", "Score"],
        allFindings.map((g) => [
          g.ruleId,
          g.category,
          g.level,
          String(g.count),
          String(g.priorityScore),
        ]),
      ),
    );
    push("");
  }

  return lines.join("\n");
}
