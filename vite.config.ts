import { defineConfig, type Plugin } from "vitest/config";

/**
 * Política de seguridad de contenidos, solo en la versión publicada (en
 * desarrollo Vite necesita conexiones propias). La página solo puede cargar
 * sus propios ficheros y hablar con la API de GitHub.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self' https://api.github.com",
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join("; ");

function csp(): Plugin {
  return {
    name: "csp",
    apply: "build",
    transformIndexHtml: (html) =>
      html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
  };
}

export default defineConfig({
  // GitHub Pages sirve el sitio en /<nombre-del-repositorio>/; el flujo de
  // publicación pasa BASE_PATH. En local se usa "./".
  base: process.env.BASE_PATH ?? "./",
  plugins: [csp()],
  build: { assetsInlineLimit: 0 },
  test: {
    globals: true,
    environment: "node",
  },
});
