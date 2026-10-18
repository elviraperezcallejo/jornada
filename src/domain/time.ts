import { DateTime } from "luxon";
import { TIMEZONE, type AllowancePeriod, type AnnualView, type CivilDate, type CourseLabel, type UtcDateTime, type YearMonth } from "./types";

const CIVIL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const COURSE_RE = /^(\d{4})-(\d{2})$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isCivilDate(s: unknown): s is CivilDate {
  return typeof s === "string" && CIVIL_DATE_RE.test(s) && DateTime.fromISO(s, { zone: TIMEZONE }).isValid;
}

export function isUtcDateTime(s: unknown): s is UtcDateTime {
  return typeof s === "string" && UTC_RE.test(s) && DateTime.fromISO(s, { zone: "utc" }).isValid;
}

export function isYearMonth(s: unknown): s is YearMonth {
  return typeof s === "string" && MONTH_RE.test(s);
}

/** Instante UTC → DateTime en hora de Madrid. */
export function toMadrid(utc: UtcDateTime): DateTime {
  return DateTime.fromISO(utc, { zone: "utc" }).setZone(TIMEZONE);
}

/** Mes (hora de Madrid) en el que cae un instante. Decide el fichero de fichajes. */
export function madridMonthOf(utc: UtcDateTime): YearMonth {
  return toMadrid(utc).toFormat("yyyy-MM");
}

/** Fecha civil (hora de Madrid) en la que cae un instante. */
export function madridDateOf(utc: UtcDateTime): CivilDate {
  return toMadrid(utc).toISODate()!;
}

/** Ahora mismo, en UTC con formato estable. */
export function nowUtc(): UtcDateTime {
  return DateTime.utc().toISO({ suppressMilliseconds: false })!;
}

export function isCourseLabel(s: unknown): s is CourseLabel {
  if (typeof s !== "string") return false;
  const m = COURSE_RE.exec(s);
  if (!m) return false;
  const start = Number(m[1]);
  return (start + 1) % 100 === Number(m[2]);
}

/** Un curso va del 1 de septiembre al 31 de agosto (decisión del usuario). */
export function courseBounds(label: CourseLabel): { startsOn: CivilDate; endsOn: CivilDate } {
  if (!isCourseLabel(label)) throw new Error(`Curso no válido: ${label}`);
  const start = Number(label.slice(0, 4));
  return { startsOn: `${start}-09-01`, endsOn: `${start + 1}-08-31` };
}

/** Curso al que pertenece una fecha civil. */
export function courseOf(date: CivilDate): CourseLabel {
  if (!isCivilDate(date)) throw new Error(`Fecha no válida: ${date}`);
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const start = month >= 9 ? year : year - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export function previousCourse(label: CourseLabel): CourseLabel {
  const start = Number(courseBounds(label).startsOn.slice(0, 4)) - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

/** Periodo de cupo al que pertenece una fecha: "2027" o "2026-27". */
export function leavePeriodKey(date: CivilDate, period: AllowancePeriod): string {
  if (!isCivilDate(date)) throw new Error(`Fecha no válida: ${date}`);
  return period === "anio_natural" ? date.slice(0, 4) : courseOf(date);
}

/** ¿Es una clave de periodo válida para ese tipo de periodo? */
export function isLeavePeriodKey(key: unknown, period?: AllowancePeriod): boolean {
  const year = typeof key === "string" && /^\d{4}$/.test(key);
  if (period === "anio_natural") return year;
  if (period === "curso") return isCourseLabel(key);
  return year || isCourseLabel(key);
}

// ---------------------------------------------------------------------------
// Vista anual: curso (1 sep – 31 ago) o año natural (1 ene – 31 dic)
// ---------------------------------------------------------------------------

/** Clave del periodo anual de una fecha: "2026-27" (curso) o "2027" (año). */
export function annualKeyOf(date: CivilDate, view: AnnualView): string {
  return leavePeriodKey(date, view);
}

/** Primer y último día de un periodo anual a partir de su clave. */
export function annualBounds(key: string): { startsOn: CivilDate; endsOn: CivilDate } {
  if (isCourseLabel(key)) return courseBounds(key);
  if (typeof key === "string" && /^\d{4}$/.test(key)) return { startsOn: `${key}-01-01`, endsOn: `${key}-12-31` };
  throw new Error(`Periodo anual no válido: ${key}`);
}

/** Periodo anterior/siguiente para navegar en la vista anual. */
export function shiftAnnualKey(key: string, delta: number): string {
  if (isCourseLabel(key)) {
    const start = Number(key.slice(0, 4)) + delta;
    return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  }
  annualBounds(key); // valida
  return String(Number(key) + delta);
}

/**
 * Cursos cuyos calendarios hacen falta para cubrir un rango de fechas.
 * Un año natural necesita dos: 2027 = ene–ago (2026-27) + sep–dic (2027-28).
 */
export function coursesCovering(startsOn: CivilDate, endsOn: CivilDate): CourseLabel[] {
  const first = courseOf(startsOn);
  const last = courseOf(endsOn);
  const out: CourseLabel[] = [first];
  while (out[out.length - 1] !== last) out.push(shiftAnnualKey(out[out.length - 1]!, 1));
  return out;
}
