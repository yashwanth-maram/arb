import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// The Meteora SDKs ship an ESM build (index.mjs) that Node's native ESM loader cannot
// load (it uses directory imports). Point vitest at their CommonJS builds instead,
// which is what tsx uses when the bot runs.
export default defineConfig({
  resolve: {
    alias: {
      "@meteora-ag/dlmm": resolve("node_modules/@meteora-ag/dlmm/dist/index.js"),
      "@meteora-ag/cp-amm-sdk": resolve("node_modules/@meteora-ag/cp-amm-sdk/dist/index.js"),
    },
  },
});