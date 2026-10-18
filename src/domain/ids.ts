/**
 * Identificador único generado en el dispositivo.
 * En el navegador, crypto.randomUUID() exige contexto seguro (HTTPS o
 * localhost); GitHub Pages sirve por HTTPS.
 */
export function newId(): string {
  return crypto.randomUUID();
}
