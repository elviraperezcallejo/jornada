/// <reference types="vite/client" />
import type { PdfJsLike } from "./pdfText";

/**
 * Carga pdf.js solo cuando hace falta (al importar un calendario), para no
 * hacer más lenta la pantalla de fichaje. Se usa la versión "legacy" de
 * pdf.js, pensada para navegadores menos recientes (p. ej. Safari de iOS
 * algo antiguo). El "worker" se sirve desde la propia app, sin depender de
 * otros servidores.
 */
export async function loadPdfjs(): Promise<PdfJsLike> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const worker = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
  pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
  return pdfjs as unknown as PdfJsLike;
}
