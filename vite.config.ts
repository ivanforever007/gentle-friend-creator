import { defineConfig } from "@lovable.dev/vite-tanstack-config";

// FFmpeg.wasm requires SharedArrayBuffer, which requires cross-origin isolation.
// We set COOP/COEP via a tiny middleware in the dev server. In production these
// headers are set in the HTML response via `<head>` meta isn't enough — but
// modern Cloudflare/edge defaults at lovable.app already serve workers cross-origin
// safely; we add a Vite plugin to inject the headers locally.
export default defineConfig({
  vite: {
    plugins: [
      {
        name: "isolation-headers",
        configureServer(server) {
          server.middlewares.use((_req, res, next) => {
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
            res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
            next();
          });
        },
        configurePreviewServer(server) {
          server.middlewares.use((_req, res, next) => {
            res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
            res.setHeader("Cross-Origin-Embedder-Policy", "credentialless");
            next();
          });
        },
      },
    ],
    optimizeDeps: {
      exclude: ["@ffmpeg/ffmpeg", "@ffmpeg/util"],
    },
  },
});
