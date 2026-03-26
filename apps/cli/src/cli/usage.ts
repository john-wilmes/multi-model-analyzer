export function printUsage(): void {
  console.log(`
Multi-Model Analyzer (mma)

Usage:
  mma index [-c config.json] [-v] [--affected] [--enrich] [--baseline file.db]
            [--format json|table|sarif] [--watch [-w] [--watch-interval N]]
            [--force-full-reindex]         Index repositories (default: table)
  mma query [-c config.json] "..." [--format json|table|sarif]
                                                Query the index (default: table)
  mma affected <rev-range> [--db path] [--repo name] [--max-depth N]
             [--format json|table|sarif]        Show blast radius (default: table)
  mma delta <rev-range> [-c config.json] [--db path] [--format markdown|json|sarif] [--exit-code]
                                                Show new/worsened findings for changed files (default: markdown)
  mma serve [--db path] [--transport stdio|http] [--port 3001] [--host 127.0.0.1]
                                                Start MCP server
  mma export [--db path] [-o file.db] [--salt hex] [--raw]
                                                Export SQLite DB (default: anonymized)
  mma import <file.db> [--db path] [-v]         Import raw export baseline
  mma merge file1.db file2.db ... [-o merged.db]
                                                Merge anonymized export DBs
  mma baseline create [-o baseline.json] [--db path]
                                                Snapshot findings as known-violations baseline
  mma baseline check --baseline baseline.json [--db path]
                                                Check for new violations (exit 1 if found)
  mma validate [--db path] [--mirrors dir] [--sample-size 50] [--seed 42]
               [--format json|table|markdown] [-o file]
                                                Validate SARIF findings quality
  mma report [--db path] [-o file] [--format json|table|sarif|markdown|both]
             [--include-sarif] [--salt hex] [--note "text"]
                                                Generate anonymized report (default: json)
  mma practices [--db path] [--format json|table|markdown] [-o file]
                                                Best-practices recommendations (default: markdown)
  mma catalog [--db path] [--repo name] [-o dir]
                                                Export Backstage catalog-info.yaml (default: stdout)
  mma audit [--audit-file file.json] [--repo name] [--db path] [-v]
                                                Parse npm audit JSON and check vulnerability reachability
  mma enrich [--db path] [--max-api-calls N] [--ollama-url URL] [--ollama-model M] [--repo name] [-v]
                                                Enrich summaries with Ollama (Tier 3)
  mma compress [--db path]                      Gzip the analysis database
  mma dashboard [--db path] [--port 3000] [--host 127.0.0.1]
                                                Serve local web dashboard
  mma explore [--db path] [--config path] [--backend <name>] [-v]
                                                Interactive incremental indexing (guided repo discovery)
  mma index-org <org-name> [--concurrency N] [--language ts,js] [--batch-size N]
            [--llm-provider anthropic|openai] [--llm-model M]
            [--force-full-reindex]             Scan & index a GitHub org

Options:
  -c, --config    Path to config file (default: mma.config.json)
  -v, --verbose   Enable verbose output
  --db            Path to SQLite database (default: data/mma.db)
  --affected      Scope analysis to changed files and their blast radius
  -w, --watch     Re-index on a timer until interrupted
  --watch-interval  Seconds between watch cycles (default: 30)
  -o, --output    Output file path (default: report.json)
  --format        Output format (varies by command, see above)
  --include-sarif Include redacted SARIF in report
  --raw           Export without anonymization (for baseline sharing)
  --baseline      Path to raw export DB; auto-imports on fresh DB before indexing
  --salt          Hex salt for redaction hashing
  --note          Free-text note to include in report
  --mirrors       Path to bare repo mirrors (for fault validation)
  --sample-size   Findings to sample per check (default: 50)
  --seed          PRNG seed for reproducibility (default: 42)
  --port          Port for dashboard server (default: 3000)
  --host          Host/IP to bind dashboard server (default: 127.0.0.1)
  --cors-origin   Allowed CORS origin(s) for the dashboard API (repeatable, e.g. --cors-origin http://localhost:5173)
  --force-full-reindex  Clear and rebuild graph for each repo (default: incremental)
  --enrich        Enable LLM enrichment (Tier 3) during indexing
  --ollama-url    Ollama endpoint (default: http://localhost:11434)
  --ollama-model  Ollama model (default: qwen2.5-coder:1.5b)
  --llm-provider  LLM backend: ollama (default), anthropic, or openai
  --llm-api-key   API key for cloud LLM (or set ANTHROPIC_API_KEY / OPENAI_API_KEY)
  --llm-model     Override model name (default: claude-haiku-4-5-20251001 / gpt-4o-mini)
  --backend       Storage backend: sqlite (default) or kuzu
  --transport     MCP transport: stdio (default) or http (use with serve)
  --exit-code     Exit with code 1 if new/updated findings exist (use with delta)
  --repo          Filter to a single repo (use with affected, catalog)
  --max-depth     Max blast radius depth (default: 5, use with affected)
  -h, --help      Show this help message
  --version       Show version number
`);
}
