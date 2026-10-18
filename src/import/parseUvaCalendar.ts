import { DateTime } from "luxon";
import { newId } from "../domain/ids";
import { isCivilDate, isCourseLabel } from "../domain/time";
import { TIMEZONE, type CalendarEntry, type Category, type CivilDate, type CourseLabel, type UtcDateTime } from "../domain/types";

/**
 * Lector del texto del calendario académico de la UVa (formato del curso
 * 2026-27). Funciona igual con el texto extraído del PDF que con texto
 * pegado a mano. No decide nada: solo PROPONE fechas con su categoría y el
 * renglón del que salen; el usuario revisa y confirma.
 */

export interface ParseOptions {
  /** Campus cuyas fiestas locales se toman (p. ej. "Valladolid"). */
  campus: string;
  /** Centro del anexo de fiestas de centro (p. ej. "Facultad de Ciencias"). */
  centre: string;
  /** Si el texto no indica el curso (p. ej. texto pegado parcial), se usa este. */
  courseHint?: CourseLabel;
}

export interface ProposedItem {
  from: CivilDate;
  /** Solo en periodos (vacaciones de Navidad, Semana Santa…). */
  to?: CivilDate;
  category: Category;
  name: string;
  isTransfer: boolean;
  /** Renglón original, para que el usuario pueda comprobarlo. */
  sourceLine: string;
}

export interface ParseResult {
  course: CourseLabel | null;
  items: ProposedItem[];
  warnings: string[];
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

/** Minúsculas y sin tildes, para comparar títulos de sección. */
export const norm = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Quita viñetas y símbolos del principio de la línea. */
const stripBullet = (l: string) => l.replace(/^[\s•▪◦●\-–o]\s+/u, "").replace(/^[\s•▪◦●]+/u, "").trim();

function courseFromText(text: string): CourseLabel | null {
  const m = /calendario\s+acad[eé]mico\s+(\d{4})\s*[-/–]\s*(\d{2,4})/i.exec(text);
  if (!m) return null;
  const start = Number(m[1]);
  const label = `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  const end = m[2]!.length === 4 ? Number(m[2]) : 2000 + Number(m[2]);
  return end === start + 1 && isCourseLabel(label) ? label : null;
}

/** Fecha a partir de día, mes (nombre) y año opcional; sin año se deduce del curso. */
function makeDate(day: string, monthName: string, year: string | undefined, course: CourseLabel): CivilDate | null {
  const month = MONTHS[norm(monthName)];
  if (!month) return null;
  const startYear = Number(course.slice(0, 4));
  const y = year ? Number(year) : month >= 9 ? startYear : startYear + 1;
  const iso = `${y}-${String(month).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
  return isCivilDate(iso) ? iso : null;
}

function cleanName(raw: string): { name: string; isTransfer: boolean } {
  const isTransfer = /\(\s*traslado\s*\)/i.test(raw);
  const name = raw
    .replace(/\(\s*traslado\s*\)/gi, "")
    .replace(/[“”"]/g, "")
    .replace(/,?\s*ambos inclusive/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
  return { name: name.charAt(0).toUpperCase() + name.slice(1), isTransfer };
}

const SINGLE = /^(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+de\s+(\d{4}))?\s*:\s*(.+)$/i;
const RANGE =
  /^(.+?):\s*del\s+(\d{1,2})(?:\s+de\s+([a-záéíóú]+))?(?:\s+de\s+(\d{4}))?\s+al\s+(\d{1,2})\s+de\s+([a-záéíóú]+)(?:\s+de\s+(\d{4}))?/i;
const MULTI = /(\d{1,2})\s+de\s+([a-záéíóú]+)\s*:\s*(.*?)(?=\s+\d{1,2}\s+de\s+[a-záéíóú]+\s*:|$)/gi;
const LOOKS_LIKE_DATE = /\d{1,2}\s+de\s+[a-záéíóú]+|\d{1,2}\/\d{1,2}\/\d{4}/i;

type Section = "none" | "nacional" | "uva" | "local" | "centro" | "otro";

export function parseUvaCalendar(text: string, opts: ParseOptions): ParseResult {
  const warnings: string[] = [];
  const items: ProposedItem[] = [];
  const course = courseFromText(text) ?? opts.courseHint ?? null;
  if (!course) {
    return { course: null, items, warnings: ["No se ha encontrado el curso (p. ej. «Calendario académico 2026-2027»). Indícalo a mano."] };
  }

  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "\f");
  const found = { nacional: false, uva: false, local: false, campus: false, centro: false };
  let section: Section = "none";
  let campusColumns: string[] = [];
  const centreRe = new RegExp(`^${escapeRe(opts.centre)}\\s+(\\d{1,2})/(\\d{1,2})/(\\d{4})\\s+(.+)$`, "i");

  for (const raw of lines) {
    const n = norm(raw);
    if (n.startsWith("calendario academico")) continue; // cabecera de página
    if (n.startsWith("festivos de ambito nacional o regional")) { section = "nacional"; found.nacional = true; continue; }
    if (n.startsWith("dias no lectivos para toda la universidad")) { section = "uva"; found.uva = true; continue; }
    if (n.startsWith("fiestas locales")) { section = "local"; found.local = true; continue; }
    if (n.startsWith("fiesta de centro") || n.includes("fiestas de los centros")) { section = "centro"; continue; }
    if (n.startsWith("dias festivos")) continue;

    // Anexo de fiestas de centro: "Facultad de Ciencias 13/11/2026 San Alberto (traslado)"
    const cm = centreRe.exec(raw);
    if (cm) {
      const iso = `${cm[3]}-${cm[2]!.padStart(2, "0")}-${cm[1]!.padStart(2, "0")}`;
      if (isCivilDate(iso)) {
        const { name, isTransfer } = cleanName(cm[4]!);
        items.push({ from: iso, category: "centro", name, isTransfer, sourceLine: raw });
        found.centro = true;
      }
      continue;
    }

    if (section === "nacional" || section === "uva") {
      const line = stripBullet(raw);
      const r = RANGE.exec(line);
      if (r) {
        const toDate = makeDate(r[5]!, r[6]!, r[7], course);
        const fromDate = makeDate(r[2]!, r[3] ?? r[6]!, r[4] ?? (r[3] ? undefined : r[7]), course);
        if (fromDate && toDate && fromDate <= toDate) {
          const { name, isTransfer } = cleanName(r[1]!);
          items.push({ from: fromDate, to: toDate, category: "periodo_vacacional", name, isTransfer, sourceLine: raw });
          continue;
        }
      }
      const m = SINGLE.exec(line);
      if (m) {
        const date = makeDate(m[1]!, m[2]!, m[3], course);
        if (date) {
          const { name, isTransfer } = cleanName(m[4]!);
          items.push({
            from: date,
            category: section === "nacional" ? "nacional_regional" : "uva_no_lectivo",
            name, isTransfer, sourceLine: raw,
          });
          continue;
        }
      }
      if (LOOKS_LIKE_DATE.test(line)) warnings.push(`No se ha podido interpretar: «${raw}»`);
      continue;
    }

    if (section === "local") {
      const heads = [...raw.matchAll(/campus\s+de\s+([^:]+):/gi)].map((m) => m[1]!.trim());
      if (heads.length) { campusColumns = heads; continue; }
      const cells = [...raw.matchAll(MULTI)];
      if (cells.length && campusColumns.length) {
        cells.forEach((c, i) => {
          if (norm(campusColumns[i] ?? "") !== norm(opts.campus)) return;
          const date = makeDate(c[1]!, c[2]!, undefined, course);
          if (!date) return void warnings.push(`No se ha podido interpretar: «${raw}»`);
          const { name, isTransfer } = cleanName(c[3]!);
          items.push({ from: date, category: "local", name, isTransfer, sourceLine: raw });
          found.campus = true;
        });
      }
    }
  }

  items.push(...academicDates(lines, course));

  if (!found.nacional) warnings.push("No se ha encontrado la sección de festivos nacionales o regionales.");
  if (!found.uva) warnings.push("No se ha encontrado la sección de días no lectivos de la UVa.");
  if (found.local && !found.campus) warnings.push(`No se han encontrado fiestas locales del campus de ${opts.campus}.`);
  if (!found.local) warnings.push("No se ha encontrado la sección de fiestas locales.");
  if (!found.centro) warnings.push(`No se ha encontrado la fiesta de centro de «${opts.centre}».`);
  return { course, items, warnings };
}

/**
 * Fechas académicas de grado (solo referencia, NO son días no laborables):
 * inicio y fin del periodo lectivo de cada cuatrimestre.
 */
function academicDates(lines: string[], course: CourseLabel): ProposedItem[] {
  const start = lines.findIndex((l) => norm(l).startsWith("periodo de actividades academicas de grado"));
  if (start === -1) return [];
  const end = lines.findIndex((l, i) => i > start && norm(l).startsWith("periodo de actividades academicas de master"));
  const block = lines.slice(start, end === -1 ? undefined : end);
  const periods = block
    .map((l) => /^del\s+(\d{1,2})(?:\s+de\s+([a-záéíóú]+))?(?:\s+de\s+(\d{4}))?\s+al\s+(\d{1,2})\s+de\s+([a-záéíóú]+)\s+de\s+(\d{4})/i.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .slice(0, 2);
  const out: ProposedItem[] = [];
  periods.forEach((m, i) => {
    const q = i === 0 ? "1.er cuatrimestre" : "2.º cuatrimestre";
    const from = makeDate(m[1]!, m[2] ?? m[5]!, m[3] ?? (m[2] ? undefined : m[6]), course);
    const to = makeDate(m[4]!, m[5]!, m[6], course);
    const src = m[0];
    if (from) out.push({ from, category: "academico", name: `Inicio del periodo lectivo de grado (${q})`, isTransfer: false, sourceLine: src });
    if (to) out.push({ from: to, category: "academico", name: `Fin del periodo lectivo de grado, con exámenes (${q})`, isTransfer: false, sourceLine: src });
  });
  return out;
}

/**
 * Convierte la propuesta en fechas del calendario (una por día; los periodos
 * comparten groupId). Quedan como "propuesta" y sin decidir si son
 * laborables. Se descartan las que ya existen (misma fecha, categoría y nombre).
 */
export function proposalToEntries(
  items: ProposedItem[],
  origin: string,
  now: UtcDateTime,
  existing: CalendarEntry[] = [],
): CalendarEntry[] {
  const key = (date: string, category: string, name?: string) => `${date}|${category}|${norm(name ?? "")}`;
  const have = new Set(existing.filter((e) => !e.deleted).map((e) => key(e.date, e.category, e.name)));
  const out: CalendarEntry[] = [];
  for (const it of items) {
    const groupId = it.to ? newId() : undefined;
    let d = DateTime.fromISO(it.from, { zone: TIMEZONE });
    const last = DateTime.fromISO(it.to ?? it.from, { zone: TIMEZONE });
    while (d <= last) {
      const date = d.toISODate()!;
      const k = key(date, it.category, it.name);
      if (!have.has(k)) {
        have.add(k);
        out.push({
          id: newId(), updatedAt: now, date, category: it.category, isTransfer: it.isTransfer,
          name: it.name, origin, groupId, isWorkingDay: null, status: "propuesta",
        });
      }
      d = d.plus({ days: 1 });
    }
  }
  return out;
}
