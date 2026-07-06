import tsparser from "@typescript-eslint/parser";
import tsplugin from "@typescript-eslint/eslint-plugin";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    plugins: { obsidianmd },
    languageOptions: {
      parser: tsparser,
      parserOptions: { project: "./tsconfig.json" },
    },
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
    rules: {
      // ── obsidianmd 규칙 (review 시스템과 동일하게 활성화) ──
      "obsidianmd/no-static-styles-assignment":           "error",
      "obsidianmd/detach-leaves":                         "error",
      "obsidianmd/no-forbidden-elements":                 "error",
      "obsidianmd/prefer-active-doc":                     "warn",
      "obsidianmd/prefer-window-timers":                  "warn",
      "obsidianmd/prefer-file-manager-trash-file":        "warn",
      "obsidianmd/commands/no-plugin-id-in-command-id":   "warn",
      "obsidianmd/commands/no-plugin-name-in-command-name": "warn",
      "obsidianmd/vault/iterate":                         "warn",
      "obsidianmd/no-global-this":                        "warn",
      "obsidianmd/prefer-instanceof":                     "warn",
      "obsidianmd/no-unsupported-api":                    "warn",
      "obsidianmd/no-tfile-tfolder-cast":                 "warn",
      "obsidianmd/object-assign":                         "warn",

      // ── @typescript-eslint 규칙 ──
      "@typescript-eslint/no-explicit-any":               "warn",
      "@typescript-eslint/no-floating-promises":          "warn",
      "@typescript-eslint/no-misused-promises":           "warn",
      "@typescript-eslint/no-unsafe-assignment":          "warn",
      "@typescript-eslint/no-unsafe-member-access":       "warn",
      "@typescript-eslint/no-unsafe-call":                "warn",
      "@typescript-eslint/no-unsafe-argument":            "warn",
      "@typescript-eslint/no-unsafe-return":              "warn",
      "@typescript-eslint/no-unused-vars":                "warn",
      "@typescript-eslint/no-require-imports":            "warn",

      // ── 비활성화 ──
      "obsidianmd/ui/sentence-case": "off",
      "@typescript-eslint/no-deprecated": "off",
    },
  },
]);
