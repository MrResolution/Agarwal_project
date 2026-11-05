import { createReadStream, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :8000. Everything under /api (including the WebSocket feed) is proxied
// there, so the browser only ever talks to the Vite origin and no CORS setup is needed.
const API = process.env.SVS_API ?? "http://127.0.0.1:8000";

// Body tracking: serve MediaPipe's wasm runtime from node_modules at /mediapipe/wasm (dev) and copy
// it into the build, so the runtime never comes from a CDN. (The pose model itself is fetched from
// Google's model storage unless a copy is placed in public/models/; see docs/setup-and-operations.md.)
const WASM_DIR = fileURLToPath(new URL("./node_modules/@mediapipe/tasks-vision/wasm/", import.meta.url));
const WASM_FILES = ["vision_wasm_internal.js", "vision_wasm_internal.wasm", "vision_wasm_nosimd_internal.js", "vision_wasm_nosimd_internal.wasm"];

function mediapipeWasm(): Plugin {
  return {
    name: "svs-mediapipe-wasm",
    configureServer(server) {
      server.middlewares.use("/mediapipe/wasm", (req, res, next) => {
        const name = (req.url ?? "").split("?")[0]!.replace(/^\/+/, "");
        if (!WASM_FILES.includes(name)) return next();
        res.setHeader("Content-Type", name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.setHeader("Cache-Control", "public, max-age=86400");
        createReadStream(WASM_DIR + name).pipe(res);
      });
    },
    generateBundle() {
      for (const f of WASM_FILES) this.emitFile({ type: "asset", fileName: `mediapipe/wasm/${f}`, source: readFileSync(WASM_DIR + f) });
    },
  };
}

export default defineConfig({
  plugins: [react(), mediapipeWasm()],
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
