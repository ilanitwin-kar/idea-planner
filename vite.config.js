import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5174,
    strictPort: false
  },
  build: {
    outDir: "server/public",
    emptyOutDir: true
  }
});

