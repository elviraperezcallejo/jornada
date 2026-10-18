import { pdfToText, type PdfJsLike } from "../src/import/pdfText";

/** pdf.js simulado: fragmentos con su posición (x, y), desordenados como pueden venir. */
function fakePdf(pages: { str: string; x: number; y: number }[][]): PdfJsLike {
  return {
    getDocument: () => ({
      promise: Promise.resolve({
        numPages: pages.length,
        getPage: async (n: number) => ({
          getTextContent: async () => ({
            items: pages[n - 1]!.map((p) => ({ str: p.str, transform: [1, 0, 0, 1, p.x, p.y] })),
          }),
        }),
      }),
    }),
  };
}

describe("extracción de texto del PDF", () => {
  it("reconstruye líneas de arriba abajo y une las dos columnas de izquierda a derecha", async () => {
    const pdf = fakePdf([
      [
        { str: "13 de mayo: San Pedro Regalado.", x: 300, y: 700.5 },
        { str: "Campus de Segovia:", x: 50, y: 720 },
        { str: "29 de junio: San Pedro", x: 50, y: 701 },
        { str: "Campus de Valladolid:", x: 300, y: 719 },
      ],
      [{ str: "Fiesta de centro:", x: 50, y: 700 }],
    ]);
    const text = await pdfToText(pdf, new Uint8Array());
    expect(text).toBe(
      "Campus de Segovia: Campus de Valladolid:\n29 de junio: San Pedro 13 de mayo: San Pedro Regalado.\n\f\nFiesta de centro:",
    );
  });
});
