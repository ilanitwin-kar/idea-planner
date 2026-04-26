import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5174,
    strictPort: false,
    host: true,
  },
  build: {
    outDir: "server/public",
    emptyOutDir: true
  }
});

