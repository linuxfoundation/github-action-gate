// @ts-check
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  // Ignore generated / third-party directories
  { ignores: ["dist/**", "node_modules/**", "docs/**"] },

  // TypeScript source files
  {
    files: ["src/**/*.ts"],
    extends: [...tseslint.configs.recommended],
    rules: {
      // Warn rather than error on `any` — Probot typings require some casts
      "@typescript-eslint/no-explicit-any": "warn",
      // Allow unused vars when prefixed with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // Require return types on exported functions
      "@typescript-eslint/explicit-module-boundary-types": "off",
      // Allow non-null assertions (common with Probot's req.user!)
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },

  // Disable all formatting rules so Prettier owns them
  eslintConfigPrettier,

  // Test files — relax rules that are routinely violated by Jest mocks
  {
    files: ["src/__tests__/**/*.ts"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
    },
  },
);
