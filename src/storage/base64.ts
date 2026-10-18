/**
 * La API de contenidos de GitHub trabaja en Base64. btoa/atob solo aceptan
 * Latin-1, así que se pasa por UTF-8 para no romper tildes ni la "ñ".
 */
export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** GitHub devuelve el Base64 partido en líneas: se eliminan los saltos. */
export function base64ToUtf8(b64: string): string {
  const bin = atob(b64.replace(/\s/g, ""));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
