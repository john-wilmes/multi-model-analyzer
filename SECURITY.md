# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report vulnerabilities by one of these methods:

- **Email**: security@wilmes.co — include "MMA Security" in the subject line.
- **GitHub Security Advisories**: Use the [Private Vulnerability Reporting](https://github.com/john-wilmes/multi-model-analyzer/security/advisories/new) feature on this repository.

### What to Include

- Description of the vulnerability and its potential impact
- Steps to reproduce (config snippets, command-line flags, sample input)
- Any proof-of-concept or exploit code (if applicable)
- Your suggested fix or mitigation (optional)

Redact any paths, credentials, or personal information before sending.

## Response Timeline

| Milestone | Target |
|-----------|--------|
| Acknowledgment | 48 hours |
| Initial assessment | 7 days |
| Fix or mitigation | Best effort, coordinated with reporter |

## Scope Notes

Multi-Model Analyzer is a **local analysis tool**. In its default mode it:

- Reads source files from local disk or bare git clones
- Writes results to a local SQLite database
- Does not open any network ports or transmit data externally

The MCP server (`mma serve`) and dashboard (`mma dashboard`) do open local HTTP listeners (default: localhost only). Binding these to non-loopback interfaces is unsupported and done at the operator's own risk.
