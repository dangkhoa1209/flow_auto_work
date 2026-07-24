import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { fileURLToPath, URL } from "node:url";

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // ant-design-vue full import (~1.2MB); split further needs on-demand components
    chunkSizeWarningLimit: 1400,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (
            id.includes("ant-design-vue") ||
            id.includes("@ant-design/icons-vue")
          ) {
            return "antd";
          }
          if (/[/\\]node_modules[/\\](vue|vue-router|pinia)[/\\]/.test(id)) {
            return "vue-vendor";
          }
          if (id.includes("axios") || id.includes("marked")) {
            return "utils";
          }
          return "vendor";
        },
      },
    },
  },
});
