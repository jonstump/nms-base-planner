import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

/*
 * Governing: ADR-0004 (React view layer), SPEC-0005 Security Requirements →
 * Security Headers
 *
 * The policy below is the one the deployment must serve. It permits
 * WebAssembly compilation and nothing else that `unsafe-eval` would cover,
 * forbids inline script, and restricts connect-src to the origin because no
 * cross-origin call is legitimate for this application.
 *
 * It is applied to `vite preview` — which serves the real build output — and
 * duplicated in public/_headers for a static host. It is deliberately NOT
 * applied to `vite dev`: the dev server injects an inline HMR client, so a
 * policy forbidding inline script would break the thing it is meant to
 * protect and teach everyone to disable it. Dev is not a deployment.
 */
const csp = [
  "default-src 'self'",
  // 'wasm-unsafe-eval' permits WebAssembly.compile without permitting
  // eval() of JavaScript. Plain 'unsafe-eval' would cover both, which is
  // what SPEC-0005 forbids going beyond.
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join("; ");

export default defineConfig({
  plugins: [react()],
  build: {
    // Vite's module-preload polyfill is injected as an inline script, which
    // the policy above forbids. Every browser that can run a WASM module can
    // also handle modulepreload, so the polyfill buys nothing here and its
    // absence is what lets the CSP stay strict.
    modulePreload: { polyfill: false },
  },
  preview: {
    headers: {
      "Content-Security-Policy": csp,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  },
});
