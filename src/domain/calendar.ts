import { DateTime } from "luxon";
import { newId } from "./ids";
import { courseOf, coursesCovering } from "./time";
import { withEstimates } from "./estimate";
import {
  TIMEZONE,
  type CalendarEntry,
  type CalendarFile,
  type Category,
  type CivilDate,
  type ConfigFile,
  type ContractTerm,
  type CourseLabel,
  type IsoWeekday,
  type LeaveCategory,
  type UtcDateTime,
} from "./types";
import { validateCalendarFile } from "./validate";

/**
 * Laborabilidad de cada día a partir del contrato y del calendario.
 * Regla (decidida por el usuario): el calendario académico NO decide por sí
 * solo; solo cuentan las fechas CONFIRMADAS con su "laboral sí/no".
 */

export const LEAVE_CATEGORIES: readonly LeaveCategory[] = ["vacaciones_contrato", "permiso_personal"];
const isLeave = (c: Category): c is LeaveCategory => (LEAVE_CATEGORIES as readonly string[]).includes(c);

/** Calendarios disponibles, por curso. */
export type Calendars = Partial<Record<CourseLabel, CalendarFile>>;

export interface DayInfo {
  date: CivilDate;
  /** Condiciones de contrato vigentes ese día (null si es anterior al contrato). */
  term: ContractTerm | null;
  /** ¿Es día de trabajo según el contrato (lunes a viernes)? */
  contractWorkday: boolean;
  /** Fechas confirmadas que lo hacen no laborable (festivo, cierre…), sin contar ausencias. */
  nonWorking: CalendarEntry[];
  /** Vacaciones o permiso confirmados ese día. */
  leave: CalendarEntry | null;
  /** Día de compensación (mantiene la referencia y consume saldo). */
  compensation: CalendarEntry | null;
  /** ¿Lleva referencia de horas? */
  isWorkday: boolean;
  /** ¿Gasta un día de cupo? Solo si sin la ausencia habría sido laborable. */
  consumesLeave: boolean;
  /** Fechas aún sin decidir ese día (no afectan al cálculo; la app avisa). */
  undecided: CalendarEntry[];
  /** No hay calendario (ni real ni estimado) para el curso de esa fecha. */
  missingCalendar: boolean;
  /** Las fechas oficiales de ese curso son una estimación a partir del curso anterior. */
  estimatedCalendar: boolean;
}

export function termFor(date: CivilDate, config: ConfigFile): ContractTerm | null {
  const sorted = [...config.contractTerms].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  return sorted.find((t) => t.validFrom <= date) ?? null;
}

export function weekdayOf(date: CivilDate): IsoWeekday {
  return DateTime.fromISO(date, { zone: TIMEZONE }).weekday as IsoWeekday;
}

/** Índice fecha → fechas del calendario (sin borradas). Se calcula una vez por cálculo. */
export function indexByDate(calendars: Calendars): Map<CivilDate, CalendarEntry[]> {
  const map = new Map<CivilDate, CalendarEntry[]>();
  for (const cal of Object.values(calendars)) {
    for (const e of cal?.entries ?? []) {
      if (e.deleted) continue;
      const list = map.get(e.date);
      if (list) list.push(e);
      else map.set(e.date, [e]);
    }
  }
  return map;
}

export function dayInfo(
  date: CivilDate,
  config: ConfigFile,
  calendars: Calendars,
  index: Map<CivilDate, CalendarEntry[]> = indexByDate(calendars),
): DayInfo {
  const term = termFor(date, config);
  const contractWorkday = !!term && term.workdays.includes(weekdayOf(date));
  const entries = index.get(date) ?? [];
  const confirmed = entries.filter((e) => e.status === "confirmada" && e.isWorkingDay !== null);
  const nonWorking = confirmed.filter((e) => e.isWorkingDay === false && !isLeave(e.category));
  const leave = confirmed.find((e) => isLeave(e.category)) ?? null;
  const compensation = confirmed.find((e) => e.category === "compensacion") ?? null;
  const baseWorkday = contractWorkday && nonWorking.length === 0;
  return {
    date, term, contractWorkday, nonWorking, leave, compensation,
    isWorkday: baseWorkday && !leave,
    consumesLeave: !!leave && baseWorkday,
    undecided: entries.filter((e) => e.status !== "confirmada" || e.isWorkingDay === null),
    missingCalendar: !calendars[courseOf(date)],
    estimatedCalendar: !!calendars[courseOf(date)]?.estimatedFrom,
  };
}

export function eachDate(from: CivilDate, to: CivilDate): CivilDate[] {
  const out: CivilDate[] = [];
  let d = DateTime.fromISO(from, { zone: TIMEZONE });
  const end = DateTime.fromISO(to, { zone: TIMEZONE });
  while (d <= end) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

/**
 * Días de un rango que gastarían cupo si se marcan como vacaciones o permiso
 * (los laborables). P. ej. agosto de 2027 → 22 días si no hay festivos.
 */
export function leaveCandidateDays(from: CivilDate, to: CivilDate, config: ConfigFile, rawCalendars: Calendars): CivilDate[] {
  const calendars = withEstimates(rawCalendars, coursesCovering(from, to), config.estimateMissingCalendars);
  const idx = indexByDate(calendars);
  return eachDate(from, to).filter((d) => {
    const info = dayInfo(d, config, calendars, idx);
    return info.isWorkday;
  });
}

// ---------------------------------------------------------------------------
// Cambios que afectan a semanas ya calculadas
// ---------------------------------------------------------------------------

export interface DayChange {
  date: CivilDate;
  before: boolean;
  after: boolean;
}

/** Días cuya laborabilidad cambia entre dos versiones del calendario. */
export function laborabilityChanges(config: ConfigFile, rawBefore: Calendars, rawAfter: Calendars, dates: CivilDate[]): DayChange[] {
  // Se compara con lo que la app usaba antes (incluida una estimación), para
  // que al importar el calendario real se vea qué semanas cambian.
  const courses = [...new Set(dates.map(courseOf))];
  const before = withEstimates(rawBefore, courses, config.estimateMissingCalendars);
  const after = withEstimates(rawAfter, courses, config.estimateMissingCalendars);
  const ib = indexByDate(before);
  const ia = indexByDate(after);
  return dates
    .map((date) => ({
      date,
      before: dayInfo(date, config, before, ib).isWorkday,
      after: dayInfo(date, config, after, ia).isWorkday,
    }))
    .filter((c) => c.before !== c.after);
}

/** Lunes (fecha) de cada semana ISO afectada, ordenados. */
export function affectedWeeks(changes: DayChange[]): CivilDate[] {
  const mondays = new Set(
    changes.map((c) => DateTime.fromISO(c.date, { zone: TIMEZONE }).startOf("week").toISODate()!),
  );
  return [...mondays].sort();
}

// ---------------------------------------------------------------------------
// Edición del calendario (planes puros, como en los fichajes)
// ---------------------------------------------------------------------------

/** Lote de cambios sobre el calendario de un curso: un único commit. */
export interface CalendarOp {
  opId: string;
  course: CourseLabel;
  entries: CalendarEntry[];
  /** Versión (updatedAt) de cada fecha antes del cambio; null si es nueva. */
  bases: Record<string, UtcDateTime | null>;
  label: string;
  /** Nombre del PDF importado (se guarda en el calendario del curso). */
  sourceName?: string;
}

export type CalendarPlan = { ok: true; op: CalendarOp } | { ok: false; errors: string[] };

function finish(cal: CalendarFile | null, course: CourseLabel, changed: CalendarEntry[], label: string, sourceName?: string): CalendarPlan {
  const bases: Record<string, UtcDateTime | null> = {};
  const current = cal?.entries ?? [];
  for (const e of changed) bases[e.id] = current.find((x) => x.id === e.id)?.updatedAt ?? null;
  const op: CalendarOp = { opId: newId(), course, entries: changed, bases, label, sourceName };
  const errs = validateCalendarFile(applyCalendarOp(cal, op));
  return errs.length ? { ok: false, errors: errs } : { ok: true, op };
}

/** Aplica el lote sobre un calendario (o uno vacío si el curso aún no tiene). */
export function applyCalendarOp(cal: CalendarFile | null, op: CalendarOp): CalendarFile {
  const base: CalendarFile = cal ? structuredClone(cal) : emptyCalendarFor(op.course);
  for (const e of op.entries) {
    const i = base.entries.findIndex((x) => x.id === e.id);
    if (i === -1) base.entries.push(e);
    else base.entries[i] = e;
  }
  if (op.sourceName) base.sourceName = op.sourceName;
  return base;
}

function emptyCalendarFor(course: CourseLabel): CalendarFile {
  const start = Number(course.slice(0, 4));
  return { schemaVersion: 1, course, startsOn: `${start}-09-01`, endsOn: `${start + 1}-08-31`, entries: [] };
}

/**
 * Confirmar fechas importadas o propuestas: el usuario decide "laboral sí/no"
 * para cada una. Solo se guardan las que se confirman.
 */
export function planConfirm(
  cal: CalendarFile | null,
  course: CourseLabel,
  decisions: { entry: CalendarEntry; isWorkingDay: boolean }[],
  now: UtcDateTime,
  label = "Confirmar fechas del calendario",
  sourceName?: string,
): CalendarPlan {
  const changed = decisions.map(({ entry, isWorkingDay }) => ({
    ...entry, isWorkingDay, status: "confirmada" as const, updatedAt: now,
  }));
  return finish(cal, course, changed, label, sourceName);
}

export interface NewEntryInput {
  from: CivilDate;
  to?: CivilDate;
  category: Category;
  name?: string;
  /** Para festivos y cierres; en vacaciones/permisos se fuerza a false y en compensación a true. */
  isWorkingDay?: boolean;
}

/** Añadir a mano una fecha o un periodo (ya confirmado: lo introduce el usuario). */
export function planAddEntries(cal: CalendarFile | null, course: CourseLabel, i: NewEntryInput, now: UtcDateTime): CalendarPlan {
  const isWorkingDay = isLeave(i.category) ? false : i.category === "compensacion" ? true : i.isWorkingDay;
  if (isWorkingDay === undefined) return { ok: false, errors: ["Indica si el día es laborable o no."] };
  const dates = eachDate(i.from, i.to ?? i.from);
  if (!dates.length) return { ok: false, errors: ["La fecha final es anterior a la inicial."] };
  const groupId = dates.length > 1 ? newId() : undefined;
  const changed = dates.map((date) => ({
    id: newId(), updatedAt: now, date, category: i.category, isTransfer: false,
    name: i.name?.trim() || undefined, origin: "manual", groupId, isWorkingDay, status: "confirmada" as const,
  }));
  return finish(cal, course, changed, `Añadir ${i.category} ${i.from}${i.to && i.to !== i.from ? `–${i.to}` : ""}`);
}

/** Cambiar una fecha (nombre, categoría o laborable). */
export function planEditEntry(
  cal: CalendarFile,
  id: string,
  changes: Partial<Pick<CalendarEntry, "name" | "category" | "isWorkingDay" | "isTransfer" | "status">>,
  now: UtcDateTime,
): CalendarPlan {
  const old = cal.entries.find((e) => e.id === id && !e.deleted);
  if (!old) return { ok: false, errors: ["Esa fecha ya no existe."] };
  return finish(cal, cal.course, [{ ...old, ...changes, updatedAt: now }], `Editar fecha ${old.date}`);
}

/** Eliminar una fecha o, con wholeGroup, todo su periodo (p. ej. toda la Navidad). */
export function planDeleteEntry(cal: CalendarFile, id: string, now: UtcDateTime, wholeGroup = false): CalendarPlan {
  const old = cal.entries.find((e) => e.id === id && !e.deleted);
  if (!old) return { ok: false, errors: ["Esa fecha ya no existe."] };
  const targets = wholeGroup && old.groupId
    ? cal.entries.filter((e) => e.groupId === old.groupId && !e.deleted)
    : [old];
  return finish(
    cal, cal.course,
    targets.map((e) => ({ ...e, deleted: true, updatedAt: now })),
    `Eliminar ${targets.length > 1 ? `${targets.length} fechas` : `fecha ${old.date}`}`,
  );
}

/** Marcar como vacaciones o permiso unos días concretos (p. ej. los laborables de agosto). */
export function planAddLeaveDays(
  cal: CalendarFile | null,
  course: CourseLabel,
  dates: CivilDate[],
  category: LeaveCategory,
  now: UtcDateTime,
  name?: string,
): CalendarPlan {
  if (!dates.length) return { ok: false, errors: ["No hay días seleccionados."] };
  const groupId = dates.length > 1 ? newId() : undefined;
  const changed = [...dates].sort().map((date) => ({
    id: newId(), updatedAt: now, date, category, isTransfer: false, name: name?.trim() || undefined,
    origin: "manual", groupId, isWorkingDay: false, status: "confirmada" as const,
  }));
  const what = category === "vacaciones_contrato" ? "vacaciones" : "permiso personal";
  return finish(cal, course, changed, `Añadir ${what}: ${dates.length} día(s)`);
}
