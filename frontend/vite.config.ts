import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The API runs on :8000. Everything under /api (including the WebSocket feed) is proxied
// there, so the browser only ever talks to the Vite origin and no CORS setup is needed.
const API = process.env.SVS_API ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
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
