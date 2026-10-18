import { DateTime } from "luxon";
import { courseBounds, previousCourse } from "./time";
import { TIMEZONE, type CalendarEntry, type CalendarFile, type Category, type CivilDate, type CourseLabel } from "./types";
import type { Calendars } from "./calendar";

/**
 * Calendario ESTIMADO para un curso cuyo calendario oficial aún no se ha
 * publicado: se toman las fechas oficiales del curso anterior (con las
 * decisiones "laboral sí/no" que tomó el usuario) y se trasladan al curso
 * nuevo. Nunca se guarda en GitHub: se calcula al vuelo, se marca como
 * estimado en todas las pantallas y desaparece en cuanto el curso tiene
 * alguna fecha oficial importada o introducida a mano.
 *
 * Cómo se ajusta cada fecha (es una aproximación; esto no lo puedo asegurar
 * para ningún año concreto, por eso se marca como estimado):
 * - Festivos de fecha fija (12/10, 08/12, 01/05, fiestas locales…): mismo
 *   día y mes.
 * - Festivos trasladados, días no lectivos de la UVa, fiesta de centro y
 *   fechas académicas: mismo día de la semana, 52 semanas después (364
 *   días). Así un lunes de traslado vuelve al festivo original y un viernes
 *   no lectivo sigue cayendo en viernes.
 * - Semana Santa: misma posición respecto al Domingo de Resurrección.
 * - Navidad y otros periodos: mismo día y mes.
 * - Vacaciones, permisos y compensaciones NO se copian: son personales.
 */

/** Categorías "oficiales" (las que vienen del calendario académico o laboral). */
export const OFFICIAL_CATEGORIES: readonly Category[] = [
  "nacional_regional", "uva_no_lectivo", "local", "centro", "periodo_vacacional", "academico",
];
const isOfficial = (e: CalendarEntry) => !e.deleted && OFFICIAL_CATEGORIES.includes(e.category);

/** Domingo de Resurrección (calendario gregoriano, algoritmo de Meeus/Jones/Butcher). */
export function easterSunday(year: number): CivilDate {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

const dt = (d: CivilDate) => DateTime.fromISO(d, { zone: TIMEZONE });

function sameDayNextYear(d: CivilDate): CivilDate {
  return dt(d).plus({ years: 1 }).toISODate()!; // 29/02 → 28/02
}

function sameWeekdayNextYear(d: CivilDate): CivilDate {
  return dt(d).plus({ days: 364 }).toISODate()!;
}

/** Para fechas cercanas a la Pascua (±21 días), misma distancia a la Pascua del año siguiente. */
function easterRelative(d: CivilDate): CivilDate | null {
  const year = dt(d).year;
  const offset = Math.round(dt(d).diff(dt(easterSunday(year)), "days").days);
  if (Math.abs(offset) > 21) return null;
  return dt(easterSunday(year + 1)).plus({ days: offset }).toISODate()!;
}

export function shiftDate(e: CalendarEntry): CivilDate {
  switch (e.category) {
    case "nacional_regional":
    case "local":
      return e.isTransfer ? sameWeekdayNextYear(e.date) : sameDayNextYear(e.date);
    case "uva_no_lectivo":
    case "centro":
    case "academico":
      return sameWeekdayNextYear(e.date);
    case "periodo_vacacional":
      return easterRelative(e.date) ?? sameDayNextYear(e.date);
    default:
      return sameDayNextYear(e.date);
  }
}

/** ¿Tiene el curso alguna fecha oficial propia (importada o puesta a mano)? */
export function hasOfficialDates(cal: CalendarFile | undefined): boolean {
  return !!cal && cal.entries.some(isOfficial);
}

/** Estima las fechas oficiales de un curso a partir de su curso anterior. */
export function estimateFrom(prev: CalendarFile, course: CourseLabel): CalendarEntry[] {
  const { startsOn, endsOn } = courseBounds(course);
  const out: CalendarEntry[] = [];
  for (const e of prev.entries.filter(isOfficial)) {
    const date = shiftDate(e);
    if (date < startsOn || date > endsOn) continue;
    out.push({
      ...e,
      id: `estimado:${e.id}`,
      date,
      groupId: e.groupId ? `estimado:${e.groupId}` : undefined,
      origin: `Estimado a partir del curso ${prev.course}`,
    });
  }
  return out;
}

/**
 * Añade calendarios estimados a los cursos indicados que no tienen fechas
 * oficiales, siempre que el curso anterior sí las tenga (y sea real, no
 * otro estimado). Las fechas personales que ya tenga el curso se conservan.
 */
export function withEstimates(calendars: Calendars, courses: CourseLabel[], enabled = true): Calendars {
  if (!enabled) return calendars;
  const out: Calendars = { ...calendars };
  for (const course of courses) {
    const own = calendars[course];
    if (hasOfficialDates(own)) continue;
    const prev = calendars[previousCourse(course)];
    if (!prev || prev.estimatedFrom || !hasOfficialDates(prev)) continue;
    const { startsOn, endsOn } = courseBounds(course);
    out[course] = {
      schemaVersion: prev.schemaVersion,
      course, startsOn, endsOn,
      sourceName: own?.sourceName,
      estimatedFrom: prev.course,
      entries: [...(own?.entries ?? []), ...estimateFrom(prev, course)],
    };
  }
  return out;
}
