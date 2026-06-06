/**
 * Production build:
 *   1. Bundle src/server.tsx → dist/server.js (with SSR + Tailwind plugins)
 *   2. Compile src/styles.css → dist/styles.css (Tailwind, minified)
 *
 * dist/server.js is what `bun run start` executes.
 */
process.env.NODE_ENV = "production";

import { plugin } from "../config";
import tailwindPlugin from "bun-plugin-tailwind";

const server = await Bun.build({
  entrypoints: ["src/server.tsx"],
  outdir: "dist",
  target: "bun",
  minify: true,
  plugins: [plugin(), tailwindPlugin],
});
if (!server.success) {
  console.error(server.logs);
  process.exit(1);
}

const styles = await Bun.build({
  entrypoints: ["src/styles.css"],
  outdir: "dist",
  minify: true,
  plugins: [tailwindPlugin],
});
if (!styles.success) {
  console.error(styles.logs);
  process.exit(1);
}

console.log("✓ built dist/server.js + dist/styles.css");
