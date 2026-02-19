import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["**/dist/", "**/node_modules/", "packages/parsing/wasm/"],
  },
  tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ["packages/**/src/**/*.ts", "apps/*/src/**/*.ts"],
  })),
  {
    files: ["packages/**/src/**/*.ts", "apps/*/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript compiler already enforces these via strict + noUnused*
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],

      // Allow non-null assertions -- codebase uses them intentionally
      "@typescript-eslint/no-non-null-assertion": "off",

      // Allow empty catch blocks (graceful degradation pattern)
      "@typescript-eslint/no-empty-function": "off",
      "no-empty": ["error", { allowEmptyCatch: true }],

      // Relax for POC stage -- promote to error later
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",

      // Sync implementations of async interfaces (SQLite behind async API)
      "@typescript-eslint/require-await": "off",

      // Allow floating promises in top-level CLI code
      "@typescript-eslint/no-floating-promises": [
        "error",
        { ignoreVoid: true },
      ],

      // Allow require() in CJS interop (better-sqlite3, etc.)
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
