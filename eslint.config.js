import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

// Deliberately minimal, correctness-focused lint for the backend (server/ +
// shared/). Style and `any` rules are relaxed to keep the signal high — this is
// a bug-catcher, not a formatter. Client code is not linted here.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "client/**",
      "tests/**",
      "scripts/**",
      "script/**",
      "**/*.cjs",
      "**/*.config.*",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["server/**/*.ts", "shared/**/*.ts"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // Relaxed (pre-existing patterns; not worth churn): keep as warnings/off.
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["warn", { allowEmptyCatch: true }],
      "prefer-const": "warn",
      // Genuine bug-catchers stay as errors (these come from recommended):
      // no-dupe-keys, no-fallthrough, no-unreachable, no-cond-assign, etc.
      "no-constant-condition": ["error", { checkLoops: false }],
    },
  },
);
