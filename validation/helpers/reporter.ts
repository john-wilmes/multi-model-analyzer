interface AssertionResult {
  category: string;
  repo: string;
  label: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
}

export class ValidationReporter {
  private results: AssertionResult[] = [];

  record(result: AssertionResult): void {
    this.results.push(result);
  }

  pass(category: string, repo: string, label: string): void {
    this.results.push({ category, repo, label, status: "pass" });
  }

  fail(category: string, repo: string, label: string, detail?: string): void {
    this.results.push({ category, repo, label, status: "fail", detail });
  }

  skip(category: string, repo: string, label: string, detail?: string): void {
    this.results.push({ category, repo, label, status: "skip", detail });
  }

  get counts() {
    const pass = this.results.filter((r) => r.status === "pass").length;
    const fail = this.results.filter((r) => r.status === "fail").length;
    const skip = this.results.filter((r) => r.status === "skip").length;
    return { pass, fail, skip, total: this.results.length };
  }

  printSummary(): void {
    const { pass, fail, skip, total } = this.counts;

    console.log("\n## Validation Summary\n");
    console.log(`| Status | Count |`);
    console.log(`|--------|-------|`);
    console.log(`| Pass   | ${pass}    |`);
    console.log(`| Fail   | ${fail}    |`);
    console.log(`| Skip   | ${skip}    |`);
    console.log(`| Total  | ${total}   |`);

    const failures = this.results.filter((r) => r.status === "fail");
    if (failures.length > 0) {
      console.log("\n### Failures\n");
      console.log("| Category | Repo | Label | Detail |");
      console.log("|----------|------|-------|--------|");
      for (const f of failures) {
        console.log(
          `| ${f.category} | ${f.repo} | ${f.label} | ${f.detail ?? ""} |`,
        );
      }
    }
  }
}
