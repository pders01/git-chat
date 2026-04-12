import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "../internal/assets/dist",
    emptyOutDir: true,
    target: "es2022",
    // Shiki's lazy highlight chunk is ~2 MB raw / 247 kB gzipped (grammar
    // data, not executable code). That's inherent; the lazy split already
    // keeps it off the cold path. Silence the 500 kB warning.
    chunkSizeWarningLimit: 2500,
  },
  esbuild: {
    // Required by Lit's legacy decorators. esbuild's TS transform ignores
    // tsconfig.json's useDefineForClassFields; set it explicitly here or
    // Lit's reactive accessors get clobbered by native class fields and
    // components render empty shadow DOMs. See lit-framework README §Setup.
    useDefineForClassFields: false,
  },
  optimizeDeps: {
    include: ["three", "three/examples/jsm/controls/OrbitControls.js"],
  },
  server: {
    port: 5173,
    host: "127.0.0.1",
    proxy: {
      // Connect RPC routes and the M0 health endpoint all live on :8080.
      // The regex key covers every current *and* future service generated
      // under the gitchat.v1 package, so we don't have to remember to add
      // a proxy entry every time a new service lands.
      "^/gitchat\\.v1\\.[A-Za-z0-9]+Service/.*": {
        target: "http://localhost:18081",
        changeOrigin: true,
      },
      "/api": "http://localhost:18081",
    },
  },
});
