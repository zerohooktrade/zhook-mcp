import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  splitting: false,
  target: "es2022",
  platform: "node",
  // src/index.ts starts with a shebang; esbuild keeps it.
});
