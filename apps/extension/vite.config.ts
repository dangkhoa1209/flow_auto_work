import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { crx } from "@crxjs/vite-plugin";
import manifest from "./manifest.config";

export default defineConfig({
  plugins: [vue(), crx({ manifest })],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
    hmr: { port: 5174 },
  },
});
