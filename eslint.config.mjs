import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTypeScript,
  globalIgnores([
    ".next/**",
    ".next-playwright/**",
    "coverage/**",
    "legacy/**",
    ".cache/**",
    ".local-data/**",
    "data/generated/**",
    "data/raw/**",
    "public/vendor/maplibre/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);
