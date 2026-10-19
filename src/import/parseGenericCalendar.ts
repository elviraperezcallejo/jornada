import { isCivilDate } from "../domain/time";
import type { Category, CivilDate } from "../domain/types";
import { norm, type ProposedItem } from "./parseUvaCalendar";

/**
 * Lector GENÉRICO de calendarios laborales (para quien no es de la UVa, o
 * para PDF que no siguen el formato de la UVa). Busca renglones con una
 * fecha (o un periodo) y un texto, del tipo:
 *   "12 de octubre: Fiesta Nacional"         "12/10/2026 Fiesta Nacional"
 *   "Navidad: del 24 de diciembre al 6 de enero"   "2026-12-24 a 2027-01-06 Cierre"
 * Los encabezados sin fecha ("Festivos nacionales", "Fiestas locales",
 * "Cierres de la empresa"…) dan la categoría de lo que viene debajo.
 *
 * Es un intento de buena fe: no puede leer calendarios dibujados como
 * cuadrícula con colores (al extraer el texto, los colores se pierden) y
 * puede proponer fechas que no son festivos. Por eso todo pasa por la
 * pantalla de revisión y nada se guarda sin confirmar.
 */

export interface GenericParseOptions {
  /**
   * Año natural ("2027") o curso ("2026-27") para las fechas que no indican
   * año. Si falta, se busca en el texto ("Año 2027", "Calendario laboral 2027", "2026-2027").
   */
  hint?: string;
}

export interface GenericParseResult {
  items: ProposedItem[];
  warnings: string[];
  /** Año o curso deducido para las fechas sin año (null si no hizo falta o no se encontró). */
  period: string | null;
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const MONTH_RE = "(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)";

/** Palabras que indican que un renglón no es un festivo sino un dato del documento. */
const NOISE = /\b(?:bo[ce]\b|bocyl|bocm|dogc|decreto|resoluci[oó]n|orden\s|publicad|aprobad|sesi[oó]n|firmad|p[aá]gina|actualizad|vigencia|matr[ií]cula|plazo|solicitud|cierre de actas|entrega de actas)/i;

/** Categoría según las palabras del renglón o del encabezado. */
export function guessCategory(text: string, isRange: boolean): Category | null {
  const n = norm(text);
  if (/vacacion|navidad|semana santa|verano|pascua/.test(n) && isRange) return "periodo_vacacional";
  if (/\blocal|patron|municipal|ayuntamiento|ciudad|pueblo/.test(n)) return "local";
  if (/cierre|no laborable|puente|empresa|centro de trabajo|no lectivo/.test(n)) return "uva_no_lectivo";
  if (/nacional|autonomic|regional|comunidad|estatal|festivo|fiesta/.test(n)) return "nacional_regional";
  // Festivos habituales en España por su nombre (solo para proponer la categoría; el usuario revisa).
  if (/ano nuevo|epifania|reyes|jueves santo|viernes santo|lunes de pascua|trabajo|asuncion|hispanidad|pilar|todos los santos|constitucion|inmaculada|navidad|san jose|santiago apostol/.test(n)) return "nacional_regional";
  if (/vacacion|navidad|semana santa/.test(n)) return "periodo_vacacional";
  return null;
}

/** Año o curso que aparece en el texto: "Año 2027", "Calendario laboral 2027", "2026-2027". */
export function periodFromText(text: string): string | null {
  const course = /\b(20\d{2})\s*[-/–]\s*(20\d{2}|\d{2})\b/.exec(text);
  if (course) {
    const a = Number(course[1]);
    const b = course[2]!.length === 4 ? Number(course[2]) : 2000 + Number(course[2]);
    if (b === a + 1) return `${a}-${String(b % 100).padStart(2, "0")}`;
  }
  const year = /\b(?:a[ñn]o|calendario(?:\s+laboral)?|festivos|ejercicio)\s+(?:de\s+)?(20\d{2})\b/i.exec(text);
  return year ? year[1]! : null;
}

function yearFor(month: number, period: string | null): number | null {
  if (!period) return null;
  if (/^\d{4}$/.test(period)) return Number(period);
  const start = Number(period.slice(0, 4));
  return month >= 9 ? start : start + 1;
}

function iso(y: number, m: number, d: number): CivilDate | null {
  const s = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return isCivilDate(s) ? s : null;
}

interface Found {
  from: CivilDate;
  to?: CivilDate;
  /** Texto del renglón sin la fecha. */
  rest: string;
  missingYear: boolean;
}

/** Busca una fecha o un periodo en un renglón. */
function findDates(line: string, period: string | null): Found | null {
  const L = line;
  let m: RegExpExecArray | null;

  // Periodo con nombres de mes: "del 24 de diciembre (de 2026) al 6 de enero (de 2027)" / "del 20 al 30 de marzo"
  m = new RegExp(`(?:del?\\s+)?(\\d{1,2})(?:\\s+de\\s+${MONTH_RE})?(?:\\s+de\\s+(\\d{4}))?\\s+(?:al|a|hasta(?:\\s+el)?)\\s+(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+de\\s+(\\d{4}))?`, "i").exec(L);
  if (m) {
    const m2 = MONTHS[m[5]!.toLowerCase()]!;
    const m1 = m[2] ? MONTHS[m[2].toLowerCase()]! : m2;
    const y2 = m[6] ? Number(m[6]) : yearFor(m2, period);
    const y1 = m[3] ? Number(m[3]) : m[6] && m1 > m2 ? Number(m[6]) - 1 : m[6] ? Number(m[6]) : yearFor(m1, period);
    if (y1 && y2) {
      const from = iso(y1, m1, Number(m[1]));
      const to = iso(y2, m2, Number(m[4]));
      if (from && to && from <= to) return { from, to, rest: L.replace(m[0], " "), missingYear: false };
    }
    return { from: "", rest: L, missingYear: true };
  }

  // Periodo numérico: "24/12/2026 - 06/01/2027", "2026-12-24 a 2027-01-06"
  m = /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\s*(?:-|–|a|al|hasta)\s*(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/i.exec(L);
  if (m) {
    const from = iso(Number(m[3]), Number(m[2]), Number(m[1]));
    const to = iso(Number(m[6]), Number(m[5]), Number(m[4]));
    if (from && to && from <= to) return { from, to, rest: L.replace(m[0], " "), missingYear: false };
  }
  m = /(\d{4})-(\d{2})-(\d{2})\s*(?:–|a|al|hasta)\s*(\d{4})-(\d{2})-(\d{2})/i.exec(L);
  if (m) {
    const from = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    const to = iso(Number(m[4]), Number(m[5]), Number(m[6]));
    if (from && to && from <= to) return { from, to, rest: L.replace(m[0], " "), missingYear: false };
  }

  // Fecha con nombre de mes: "12 de octubre (de 2026)"
  m = new RegExp(`(\\d{1,2})\\s+de\\s+${MONTH_RE}(?:\\s+(?:de|del)\\s+(\\d{4}))?`, "i").exec(L);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()]!;
    const y = m[3] ? Number(m[3]) : yearFor(month, period);
    if (!y) return { from: "", rest: L, missingYear: true };
    const from = iso(y, month, Number(m[1]));
    return from ? { from, rest: L.replace(m[0], " "), missingYear: false } : null;
  }
  // ISO: 2026-10-12
  m = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(L);
  if (m) {
    const from = iso(Number(m[1]), Number(m[2]), Number(m[3]));
    return from ? { from, rest: L.replace(m[0], " "), missingYear: false } : null;
  }
  // Numérica: 12/10/2026, 12-10-2026, 12.10.2026 o sin año 12/10
  m = /\b(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{4}))?\b/.exec(L);
  if (m) {
    const month = Number(m[2]);
    if (month < 1 || month > 12) return null;
    const y = m[3] ? Number(m[3]) : yearFor(month, period);
    if (!y) return { from: "", rest: L, missingYear: true };
    const from = iso(y, month, Number(m[1]));
    return from ? { from, rest: L.replace(m[0], " "), missingYear: false } : null;
  }
  return null;
}

const WEEKDAY_RE = "(?:lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)";
const WEEKDAYS: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };

/**
 * Tablas con el mes y el año en la primera columna, como las de muchos
 * calendarios escolares o laborales:
 *   "Octubre 2026  Viernes 30  Día no lectivo"
 *   "Diciembre 2026  Lunes 7 y martes 8  Fiestas laborales"
 *   "Diciembre 2026  Del miércoles 23 al jueves 31  Vacaciones escolares"
 * Si se indica el día de la semana, se comprueba que coincide con la fecha.
 */
function monthYearRow(line: string): { found: Found[]; mismatch: string | null } | null {
  const head = new RegExp(`^${MONTH_RE}\\s+(?:de\\s+)?(\\d{4})\\s+(.+)$`, "i").exec(line);
  if (!head) return null;
  const month = MONTHS[head[1]!.toLowerCase()]!;
  const year = Number(head[2]);
  const rest = head[3]!;
  const wd = (w: string | undefined, d: CivilDate): string | null => {
    if (!w) return null;
    const want = WEEKDAYS[norm(w)];
    const got = new Date(`${d}T12:00:00Z`).getUTCDay() || 7;
    return want && want !== got ? `${w} ${Number(d.slice(8))} de ${head[1]} de ${year}` : null;
  };

  const range = new RegExp(`^(?:del?\\s+)?(?:(${WEEKDAY_RE})\\s+)?(\\d{1,2})\\s+(?:al?|hasta(?:\\s+el)?)\\s+(?:(${WEEKDAY_RE})\\s+)?(\\d{1,2})\\s+(.+)$`, "i").exec(rest);
  if (range) {
    const from = iso(year, month, Number(range[2]));
    const to = iso(year, month, Number(range[4]));
    if (from && to && from <= to) {
      return { found: [{ from, to, rest: range[5]!, missingYear: false }], mismatch: wd(range[1], from) ?? wd(range[3], to) };
    }
    return null;
  }
  const list = new RegExp(`^((?:(?:${WEEKDAY_RE})\\s+)?\\d{1,2}(?:\\s*(?:,|y|e)\\s*(?:(?:${WEEKDAY_RE})\\s+)?\\d{1,2})*)\\s+(.+)$`, "i").exec(rest);
  if (!list) return null;
  const found: Found[] = [];
  let mismatch: string | null = null;
  for (const m of list[1]!.matchAll(new RegExp(`(?:(${WEEKDAY_RE})\\s+)?(\\d{1,2})`, "gi"))) {
    const d = iso(year, month, Number(m[2]));
    if (!d) return null;
    mismatch ??= wd(m[1], d);
    found.push({ from: d, rest: list[2]!, missingYear: false });
  }
  return { found, mismatch };
}

function cleanName(rest: string): { name: string; isTransfer: boolean } {
  const isTransfer = /traslad/i.test(rest);
  const name = rest
    .replace(/\(\s*traslad[oa]\s*\)/gi, "")
    .replace(/^[\s•▪◦●\-–:;,.()o]+|[\s•▪◦●\-–:;,.()]+$/gu, "")
    .replace(/^(del?|el|los|las)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return { name: name.charAt(0).toUpperCase() + name.slice(1), isTransfer };
}

export function parseGenericCalendar(text: string, opts: GenericParseOptions = {}): GenericParseResult {
  const period = opts.hint ?? periodFromText(text);
  const items: ProposedItem[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  let headingCategory: Category | null = null;
  let missingYear = 0;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line === "\f") continue;
    const row = monthYearRow(line);
    if (row) {
      if (row.mismatch) warnings.push(`El día de la semana no coincide con la fecha en «${line}» (${row.mismatch}). Revísalo.`);
      for (const f of row.found) {
        const { name, isTransfer } = cleanName(f.rest);
        if (!name) continue;
        const category = guessCategory(name, !!f.to) ?? headingCategory ?? (f.to ? "periodo_vacacional" : "otro");
        const key = `${f.from}|${f.to ?? ""}|${norm(name)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push({ from: f.from, to: f.to, category, name, isTransfer, sourceLine: line });
      }
      continue;
    }
    const found = findDates(line, period);
    if (!found) {
      // Renglón sin fecha: puede ser un encabezado que da la categoría.
      if (line.length <= 80) headingCategory = guessCategory(line, false) ?? headingCategory;
      continue;
    }
    if (line.length > 160 || NOISE.test(line)) continue;
    if (found.missingYear) { missingYear++; continue; }
    const { name, isTransfer } = cleanName(found.rest);
    if (!name || name.length < 2) continue;
    const category = guessCategory(name, !!found.to) ?? headingCategory ?? (found.to ? "periodo_vacacional" : "otro");
    const key = `${found.from}|${found.to ?? ""}|${norm(name)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ from: found.from, to: found.to, category, name, isTransfer, sourceLine: line });
  }

  if (missingYear) {
    warnings.push(`${missingYear} fecha(s) sin año: indica el año (p. ej. 2027) o el periodo (p. ej. 2026-27) para poder leerlas.`);
  }
  return { items, warnings, period };
}
