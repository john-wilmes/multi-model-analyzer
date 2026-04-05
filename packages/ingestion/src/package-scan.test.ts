import { describe, it, expect } from "vitest";
import { buildPackageMap, findRepoDependencies } from "./package-scan.js";
import type { RepoPackages } from "./package-scan.js";

describe("buildPackageMap", () => {
  it("builds package-to-repo mapping from multiple repos", () => {
    const repos: RepoPackages[] = [
      {
        repo: "supabase-js",
        packages: [
          {
            name: "@supabase/supabase-js",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
      {
        repo: "storage",
        packages: [
          {
            name: "@supabase/storage-js",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
    ];

    const map = buildPackageMap(repos);
    expect(map.packageToRepo.get("@supabase/supabase-js")).toBe("supabase-js");
    expect(map.packageToRepo.get("@supabase/storage-js")).toBe("storage");
    expect(map.repoToPackages.get("supabase-js")).toEqual([
      "@supabase/supabase-js",
    ]);
  });

  it("handles monorepo with multiple packages", () => {
    const repos: RepoPackages[] = [
      {
        repo: "supabase",
        packages: [
          {
            name: "@supabase/auth",
            path: "packages/auth/package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
          {
            name: "@supabase/realtime",
            path: "packages/realtime/package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
    ];

    const map = buildPackageMap(repos);
    expect(map.packageToRepo.get("@supabase/auth")).toBe("supabase");
    expect(map.repoToPackages.get("supabase")).toEqual([
      "@supabase/auth",
      "@supabase/realtime",
    ]);
  });

  it("records builtAt as an ISO date string", () => {
    const map = buildPackageMap([]);
    expect(map.builtAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("does not add repos with zero named packages to repoToPackages", () => {
    const repos: RepoPackages[] = [
      { repo: "empty-repo", packages: [] },
      {
        repo: "non-empty",
        packages: [
          {
            name: "@org/pkg",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
    ];
    const map = buildPackageMap(repos);
    expect(map.repoToPackages.has("empty-repo")).toBe(false);
    expect(map.repoToPackages.has("non-empty")).toBe(true);
  });
});

describe("findRepoDependencies", () => {
  it("finds dependency connections to other repos", () => {
    const repo: RepoPackages = {
      repo: "supabase-js",
      packages: [
        {
          name: "@supabase/supabase-js",
          path: "package.json",
          dependencies: ["@supabase/storage-js", "@supabase/auth", "lodash"],
          devDependencies: ["vitest"],
          peerDependencies: [],
        },
      ],
    };

    const packageMap = buildPackageMap([
      {
        repo: "storage",
        packages: [
          {
            name: "@supabase/storage-js",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
      {
        repo: "auth",
        packages: [
          {
            name: "@supabase/auth",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
    ]);

    const deps = findRepoDependencies(repo, packageMap);
    expect(deps).toHaveLength(2);
    expect(deps.map((d) => d.repo).sort()).toEqual(["auth", "storage"]);
  });

  it("excludes self-references", () => {
    const repo: RepoPackages = {
      repo: "mono",
      packages: [
        {
          name: "@org/a",
          path: "packages/a/package.json",
          dependencies: ["@org/b"],
          devDependencies: [],
          peerDependencies: [],
        },
        {
          name: "@org/b",
          path: "packages/b/package.json",
          dependencies: [],
          devDependencies: [],
          peerDependencies: [],
        },
      ],
    };

    const packageMap = buildPackageMap([repo]);
    const deps = findRepoDependencies(repo, packageMap);
    expect(deps).toHaveLength(0); // @org/b is in the same repo
  });

  it("identifies devDependency connections", () => {
    const repo: RepoPackages = {
      repo: "app",
      packages: [
        {
          name: "@org/app",
          path: "package.json",
          dependencies: [],
          devDependencies: ["@org/test-utils"],
          peerDependencies: [],
        },
      ],
    };

    const packageMap = buildPackageMap([
      {
        repo: "test-utils",
        packages: [
          {
            name: "@org/test-utils",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
    ]);

    const deps = findRepoDependencies(repo, packageMap);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.type).toBe("devDependency");
  });

  it("identifies peerDependency connections", () => {
    const repo: RepoPackages = {
      repo: "plugin",
      packages: [
        {
          name: "@org/plugin",
          path: "package.json",
          dependencies: [],
          devDependencies: [],
          peerDependencies: ["@org/core"],
        },
      ],
    };

    const packageMap = buildPackageMap([
      {
        repo: "core",
        packages: [
          {
            name: "@org/core",
            path: "package.json",
            dependencies: [],
            devDependencies: [],
            peerDependencies: [],
          },
        ],
      },
    ]);

    const deps = findRepoDependencies(repo, packageMap);
    expect(deps).toHaveLength(1);
    expect(deps[0]!.type).toBe("peerDependency");
    expect(deps[0]!.repo).toBe("core");
  });

  it("returns empty array when no inter-repo dependencies exist", () => {
    const repo: RepoPackages = {
      repo: "isolated",
      packages: [
        {
          name: "@org/isolated",
          path: "package.json",
          dependencies: ["lodash", "express"],
          devDependencies: ["vitest"],
          peerDependencies: [],
        },
      ],
    };

    const packageMap = buildPackageMap([]);
    const deps = findRepoDependencies(repo, packageMap);
    expect(deps).toHaveLength(0);
  });
});
