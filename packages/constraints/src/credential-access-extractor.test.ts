import { describe, it, expect, beforeAll } from "vitest";
import { extractCredentialAccesses } from "./credential-access-extractor.js";
import { initTreeSitter } from "@mma/parsing";
import type { CredentialAccess } from "./types.js";

function access(
  accesses: readonly CredentialAccess[],
  field: string,
): CredentialAccess | undefined {
  return accesses.find((a) => a.field === field);
}

describe("extractCredentialAccesses", () => {
  beforeAll(async () => {
    await initTreeSitter();
  }, 15_000);

  it("returns empty result for empty input", async () => {
    const result = await extractCredentialAccesses([]);
    expect(result.accesses).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.filesScanned).toBe(0);
    expect(result.stats.filesWithAccesses).toBe(0);
    expect(result.stats.totalAccesses).toBe(0);
  });

  it("extracts field from self.options.integrator.credentials.fieldName", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/foo/service.js",
        content: `
          class FooClient {
            getToken() {
              return self.options.integrator.credentials.apiToken;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.accesses).toHaveLength(1);
    const a = result.accesses[0]!;
    expect(a.field).toBe("apiToken");
    expect(a.accessKind).toBe("read");
    expect(a.hasDefault).toBe(false);
    expect(a.guardConditions).toHaveLength(0);
  });

  it("extracts field from this.options.integrator.credentials.fieldName", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/bar/service.js",
        content: `
          class BarClient {
            connect() {
              const url = this.options.integrator.credentials.serverUrl;
              return url;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "serverUrl");
    expect(a).toBeDefined();
    expect(a!.accessKind).toBe("read");
  });

  it("extracts field from alias pattern", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/baz/service.js",
        content: `
          function doWork(options) {
            const creds = self.options.integrator.credentials;
            return creds.username + ':' + creds.password;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const username = access(result.accesses, "username");
    const password = access(result.accesses, "password");
    expect(username).toBeDefined();
    expect(password).toBeDefined();
    expect(username!.accessKind).toBe("read");
    expect(password!.accessKind).toBe("read");
  });

  it("extracts both fields from destructuring", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/dest/service.js",
        content: `
          function setup() {
            const { apiKey, secretKey } = this.options.integrator.credentials;
            return { apiKey, secretKey };
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const apiKey = access(result.accesses, "apiKey");
    const secretKey = access(result.accesses, "secretKey");
    expect(apiKey).toBeDefined();
    expect(secretKey).toBeDefined();
    expect(apiKey!.accessKind).toBe("read");
    expect(secretKey!.accessKind).toBe("read");
    expect(result.stats.byPattern["destructuring"]).toBe(2);
  });

  it("extracts field from _.get with default (hasDefault: true)", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/lodash/service.js",
        content: `
          function getPort(credentials) {
            return _.get(credentials, 'port', 443);
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "port");
    expect(a).toBeDefined();
    expect(a!.hasDefault).toBe(true);
    expect(a!.accessKind).toBe("default-fallback");
    expect(result.stats.byPattern["lodash-get"]).toBe(1);
  });

  it("extracts field from _.get without default (hasDefault: false)", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/lodash2/service.js",
        content: `
          function getToken(credentials) {
            return _.get(credentials, 'token');
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "token");
    expect(a).toBeDefined();
    expect(a!.hasDefault).toBe(false);
    expect(a!.accessKind).toBe("read");
  });

  it("marks write as accessKind write", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/write/service.js",
        content: `
          function storeToken(value) {
            self.options.integrator.credentials.token = value;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "token");
    expect(a).toBeDefined();
    expect(a!.accessKind).toBe("write");
  });

  it("marks default-fallback when credential is left side of ||", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/fallback/service.js",
        content: `
          function getField() {
            return self.options.integrator.credentials.proxyHost || configuration.proxyHost.default;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "proxyHost");
    expect(a).toBeDefined();
    expect(a!.accessKind).toBe("default-fallback");
    expect(a!.hasDefault).toBe(true);
  });

  it("populates guardConditions when credential field is in enclosing if condition", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/guard/service.js",
        content: `
          function setup() {
            if (self.options.integrator.credentials.useProxy) {
              const host = self.options.integrator.credentials.proxyHost;
              return host;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const proxyHost = access(result.accesses, "proxyHost");
    expect(proxyHost).toBeDefined();
    expect(proxyHost!.guardConditions).toHaveLength(1);
    const guard = proxyHost!.guardConditions[0]!;
    expect(guard.field).toBe("useProxy");
    expect(guard.operator).toBe("truthy");
    expect(guard.negated).toBe(false);
  });

  it("sets negated: true for access in else branch", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/guard2/service.js",
        content: `
          function setup() {
            if (self.options.integrator.credentials.useProxy) {
              return 'yes';
            } else {
              const host = self.options.integrator.credentials.directHost;
              return host;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const directHost = access(result.accesses, "directHost");
    expect(directHost).toBeDefined();
    expect(directHost!.guardConditions).toHaveLength(1);
    expect(directHost!.guardConditions[0]!.negated).toBe(true);
  });

  it("computes stats correctly across multiple files", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/a/service.js",
        content: `const x = self.options.integrator.credentials.field1;`,
      },
      {
        path: "clients/b/service.js",
        content: `const y = self.options.integrator.credentials.field2;`,
      },
      {
        path: "clients/c/service.js",
        content: `// no credentials here`,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    expect(result.stats.filesScanned).toBe(3);
    expect(result.stats.filesWithAccesses).toBe(2);
    expect(result.stats.totalAccesses).toBe(2);
    expect(result.accesses.map((a) => a.field).sort()).toEqual(["field1", "field2"]);
  });

  it("preserves full nested dotted path for deeply nested credential access", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/nested/service.js",
        content: `
          function getClientId() {
            return self.options.integrator.credentials.oauth.clientId;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "oauth.clientId");
    expect(a).toBeDefined();
    expect(a!.field).toBe("oauth.clientId");
    expect(a!.accessKind).toBe("read");
  });

  it("typeof !== guard sets negated: true", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/typeof/service.js",
        content: `
          function setup() {
            if (typeof self.options.integrator.credentials.mode !== 'string') {
              const token = self.options.integrator.credentials.fallback;
              return token;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const fallback = access(result.accesses, "fallback");
    expect(fallback).toBeDefined();
    expect(fallback!.guardConditions).toHaveLength(1);
    const guard = fallback!.guardConditions[0]!;
    expect(guard.field).toBe("mode");
    expect(guard.operator).toBe("typeof");
    expect(guard.value).toBe("string");
    // typeof !== 'string' means negated should be true
    expect(guard.negated).toBe(true);
  });

  it("compound AND condition in guard does not corrupt rhs", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/compound/service.js",
        content: `
          function setup() {
            if (self.options.integrator.credentials.mode === 'oauth' && self.options.integrator.credentials.enabled) {
              const token = self.options.integrator.credentials.oauthToken;
              return token;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const oauthToken = access(result.accesses, "oauthToken");
    expect(oauthToken).toBeDefined();
    expect(oauthToken!.guardConditions).toHaveLength(1);
    const guard = oauthToken!.guardConditions[0]!;
    // Should have parsed either the equality or truthy check cleanly, without the && tail in the value
    expect(guard.field).toBeDefined();
    if (guard.operator === "==") {
      // Value should be "oauth", not "oauth && ..."
      expect(guard.value).toBe("oauth");
    }
  });

  it("normalizes optional chaining ?. to . in extracted field names", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/optchain/service.js",
        content: `
          function getMode() {
            return self.options.integrator.credentials.internalLoginService?.mode;
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const a = access(result.accesses, "internalLoginService.mode");
    expect(a).toBeDefined();
    expect(a!.field).toBe("internalLoginService.mode");
    // Should NOT contain the ?. characters
    expect(a!.field).not.toContain("?.");
  });

  it("normalizes optional chaining in guard condition field names", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/optguard/service.js",
        content: `
          function setup() {
            if (self.options.integrator.credentials.internalLoginService?.mode) {
              const x = self.options.integrator.credentials.token;
              return x;
            }
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    const token = access(result.accesses, "token");
    expect(token).toBeDefined();
    expect(token!.guardConditions).toHaveLength(1);
    const guard = token!.guardConditions[0]!;
    expect(guard.field).toBe("internalLoginService.mode");
    expect(guard.field).not.toContain("?.");
  });

  it("skips template strings with interpolations in lodash get", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/test/service.js",
        content: `
          const _ = require('lodash');
          const creds = self.options.integrator.credentials;
          const val = _.get(creds, \`\${dynamicField}\`);
          const static1 = _.get(creds, \`staticField\`);
          const static2 = _.get(creds, 'normalField');
        `,
      },
    ]);
    const fields = result.accesses.map((a) => a.field).sort();
    // Interpolated template skipped, static template and string kept
    expect(fields).toContain("staticField");
    expect(fields).toContain("normalField");
    expect(fields).not.toContain("${dynamicField}");
  });

  it("strips method call suffix from credential field access", async () => {
    const result = await extractCredentialAccesses([
      {
        path: "clients/epic/context/get-jwt-private-key.js",
        content: `
          function getJwtPrivateKey() {
            return self.options.integrator.credentials.jwtPrivateKey.replace(/\\\\n/g, '\\n');
          }
        `,
      },
    ]);
    expect(result.errors).toHaveLength(0);
    // Should extract "jwtPrivateKey", not "jwtPrivateKey.replace"
    const a = access(result.accesses, "jwtPrivateKey");
    expect(a).toBeDefined();
    expect(a!.field).toBe("jwtPrivateKey");
    expect(a!.accessKind).toBe("read");
    // Must NOT produce a "jwtPrivateKey.replace" entry
    const bad = access(result.accesses, "jwtPrivateKey.replace");
    expect(bad).toBeUndefined();
  });
});
