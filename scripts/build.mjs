import { build } from "esbuild";

await build({
  entryPoints: ["src/plugin/index.ts"],
  outfile: "dist/plugin.js",
  bundle: true,
  format: "esm",
  platform: "node",
  target: "esnext",
  external: ["node:*", "bun:*"],
  logLevel: "info",
});
