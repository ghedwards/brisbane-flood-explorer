import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "rust/**",
      "site/**",
      "work/**",
      "viewer/data/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["viewer/**/*.js"],
    languageOptions: {
      sourceType: "script",
      globals: {
        ...globals.browser,
        ...globals.worker,
        module: "readonly",
        require: "readonly",
        L: "readonly",
        GeoTIFF: "readonly",
      },
    },
  },
  {
    files: ["tests/**/*.js", "scripts/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.browser },
    },
  },
  {
    rules: {
      "no-unused-vars": [
        "error",
        { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" },
      ],
    },
  },
];
