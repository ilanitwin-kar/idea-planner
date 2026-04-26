import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5174,
    strictPort: false,
    host: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});

