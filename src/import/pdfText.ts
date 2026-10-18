/**
 * Extracción del texto de un PDF en el navegador con pdf.js (Apache-2.0).
 * Los fragmentos de texto se agrupan en líneas por su posición vertical, de
 * modo que las tablas a dos columnas quedan en una misma línea, de izquierda
 * a derecha. El PDF nunca sale del dispositivo.
 */

/** Subconjunto de la API de pdf.js que usamos (permite inyectarla en pruebas). */
export interface PdfJsLike {
  getDocument(src: { data: Uint8Array }): {
    promise: Promise<{
      numPages: number;
      getPage(n: number): Promise<{
        getTextContent(): Promise<{ items: unknown[] }>;
      }>;
      destroy?(): Promise<void>;
    }>;
  };
}

interface TextItem {
  str: string;
  transform: number[];
}

const isTextItem = (x: unknown): x is TextItem =>
  typeof x === "object" && x !== null && typeof (x as TextItem).str === "string" && Array.isArray((x as TextItem).transform);

/** Tolerancia (en puntos PDF) para considerar que dos fragmentos están en la misma línea. */
const LINE_TOLERANCE = 3;

export async function pdfToText(pdfjs: PdfJsLike, data: Uint8Array): Promise<string> {
  const doc = await pdfjs.getDocument({ data }).promise;
  const pages: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items.filter(isTextItem).filter((i) => i.str.trim() !== "");
    // Orden: de arriba abajo (y decreciente) y de izquierda a derecha.
    items.sort((a, b) => b.transform[5]! - a.transform[5]! || a.transform[4]! - b.transform[4]!);
    const lines: { y: number; parts: TextItem[] }[] = [];
    for (const it of items) {
      const y = it.transform[5]!;
      const line = lines.find((l) => Math.abs(l.y - y) <= LINE_TOLERANCE);
      if (line) line.parts.push(it);
      else lines.push({ y, parts: [it] });
    }
    lines.sort((a, b) => b.y - a.y);
    pages.push(
      lines
        .map((l) =>
          l.parts
            .sort((a, b) => a.transform[4]! - b.transform[4]!)
            .map((i) => i.str.trim())
            .join(" ")
            .replace(/\s+/g, " "),
        )
        .join("\n"),
    );
  }
  await doc.destroy?.();
  return pages.join("\n\f\n"); // \f separa páginas
}
