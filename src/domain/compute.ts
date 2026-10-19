import { DateTime } from "luxon";
import { dayInfo, eachDate, indexByDate, termFor, type Calendars, type DayInfo } from "./calendar";
import { live } from "./sessions";
import { withEstimates } from "./estimate";
import {
  annualBounds,
  annualKeyOf,
  courseBounds,
  coursesCovering,
  madridDateOf,
} from "./time";
import {
  TIMEZONE,
  type AnnualView,
  type CarryoverFile,
  type CivilDate,
  type ConfigFile,
  type CourseLabel,
  type LeaveCategory,
  type UtcDateTime,
  type WorkSession,
  type YearMonth,
} from "./types";

/**
 * Cálculos de horas (todo en hora de Madrid).
 *
 * - Cada fichaje cerrado se parte en cada medianoche de Madrid; cada trozo
 *   suma al día en que cae. La duración es tiempo real transcurrido, así que
 *   el día del cambio de hora (25 h o 23 h) se cuenta bien.
 * - Un fichaje abierto de HOY suma hasta "ahora" y se marca como provisional.
 *   Uno abierto de un día anterior (pendiente de revisión) no suma nada y se
 *   señala para corregirlo: nunca se inventa la hora de salida.
 * - Referencia de un día = horas semanales ÷ días de trabajo del contrato
 *   (37,5 ÷ 5 = 7,5 h) si es laborable; 0 si no.
 * - Las horas trabajadas en días no laborables (sábados, festivos…) suman
 *   igualmente al total, y además se muestran aparte.
 * - En los periodos en curso, la diferencia se calcula con la referencia
 *   HASTA HOY (incluido); la referencia del periodo completo se da aparte.
 */

const MS_PER_HOUR = 3_600_000;

export interface CalcContext {
  config: ConfigFile;
  calendars: Calendars;
  sessions: WorkSession[];
  now: UtcDateTime;
}

export interface DayResult {
  date: CivilDate;
  /** Anterior al inicio del registro: no cuenta ni horas ni referencia. */
  beforeTracking: boolean;
  workedHours: number;
  referenceHours: number;
  info: DayInfo;
  /** Incluye un fichaje abierto hoy (las horas siguen subiendo). */
  provisional: boolean;
  /** Fichajes abiertos desde este día y sin salida: no suman hasta corregirlos. */
  pendingSessions: WorkSession[];
  isFuture: boolean;
}

export interface PeriodSummary {
  from: CivilDate;
  to: CivilDate;
  workedHours: number;
  /** Referencia de todo el periodo. */
  referenceHours: number;
  /** Referencia de los días hasta hoy (incluido). En periodos pasados = referenceHours. */
  referenceToDate: number;
  /** workedHours − referenceToDate. */
  diffHours: number;
  /** diffHours ÷ referenceToDate; null si la referencia es 0 (no aplica). */
  diffRatio: number | null;
  /** Horas trabajadas en días sin referencia (fines de semana, festivos, vacaciones…). */
  workedOnNonWorkdays: number;
  workdays: number;
  workdaysToDate: number;
  provisional: boolean;
  pendingSessions: WorkSession[];
  /** Fechas del periodo con propuestas sin decidir en el calendario. */
  undecidedDates: CivilDate[];
  /** Cursos sin calendario (ni real ni estimado) que afectan al periodo. */
  missingCourses: CourseLabel[];
  /** Cursos cuyas fechas oficiales son una estimación a partir del curso anterior. */
  estimatedCourses: CourseLabel[];
  days: DayResult[];
}

// ---------------------------------------------------------------------------
// Fichajes → horas por día
// ---------------------------------------------------------------------------

/** Milisegundos trabajados por día de Madrid, partiendo en cada medianoche. */
export function splitByDay(sessions: WorkSession[], now: UtcDateTime): {
  ms: Map<CivilDate, number>;
  provisionalDays: Set<CivilDate>;
  pending: Map<CivilDate, WorkSession[]>;
} {
  const ms = new Map<CivilDate, number>();
  const provisionalDays = new Set<CivilDate>();
  const pending = new Map<CivilDate, WorkSession[]>();
  const today = madridDateOf(now);

  for (const s of live(sessions)) {
    let endIso = s.end;
    if (endIso === null) {
      const startDay = madridDateOf(s.start);
      if (startDay < today) {
        pending.set(startDay, [...(pending.get(startDay) ?? []), s]);
        continue;
      }
      if (s.start >= now) continue;
      endIso = now;
      provisionalDays.add(startDay);
    }
    let cur = DateTime.fromISO(s.start, { zone: "utc" }).setZone(TIMEZONE);
    const end = DateTime.fromISO(endIso, { zone: "utc" }).setZone(TIMEZONE);
    while (cur < end) {
      const nextMidnight = cur.startOf("day").plus({ days: 1 });
      const segEnd = end < nextMidnight ? end : nextMidnight;
      const day = cur.toISODate()!;
      ms.set(day, (ms.get(day) ?? 0) + (segEnd.toMillis() - cur.toMillis()));
      cur = segEnd;
    }
  }
  return { ms, provisionalDays, pending };
}

/** Primer día que cuenta: el configurado o, si no hay, el del primer fichaje (o hoy). */
export function trackingStart(ctx: CalcContext): CivilDate {
  if (ctx.config.trackingStartsOn) return ctx.config.trackingStartsOn;
  const first = live(ctx.sessions).reduce<string | null>((m, s) => (m === null || s.start < m ? s.start : m), null);
  return first ? madridDateOf(first) : madridDateOf(ctx.now);
}

/** Referencia de un día laborable según el contrato vigente ese día. */
export function dailyReference(info: DayInfo): number {
  if (!info.isWorkday || !info.term) return 0;
  return info.term.weeklyHours / info.term.workdays.length;
}

// ---------------------------------------------------------------------------
// Periodos
// ---------------------------------------------------------------------------

export function summarize(from: CivilDate, to: CivilDate, ctx: CalcContext): PeriodSummary {
  const today = madridDateOf(ctx.now);
  const split = splitByDay(ctx.sessions, ctx.now);
  const calendars = effectiveCalendars(ctx, from, to);
  const idx = indexByDate(calendars);
  const start = trackingStart(ctx);
  const days: DayResult[] = eachDate(from, to).map((date) => {
    const info = dayInfo(date, ctx.config, calendars, idx);
    const beforeTracking = date < start;
    return {
      date,
      beforeTracking,
      workedHours: beforeTracking ? 0 : (split.ms.get(date) ?? 0) / MS_PER_HOUR,
      referenceHours: beforeTracking ? 0 : dailyReference(info),
      info,
      provisional: split.provisionalDays.has(date),
      pendingSessions: split.pending.get(date) ?? [],
      isFuture: date > today,
    };
  });

  return fromDays(days);
}

const iso = (d: DateTime) => d.toISODate()!;
const madrid = (date: CivilDate) => DateTime.fromISO(date, { zone: TIMEZONE });

export function daySummary(date: CivilDate, ctx: CalcContext) {
  return summarize(date, date, ctx);
}

/** Semana ISO (lunes a domingo) que contiene la fecha. */
export function weekSummary(date: CivilDate, ctx: CalcContext) {
  const d = madrid(date);
  return summarize(iso(d.startOf("week")), iso(d.endOf("week")), ctx);
}

export function monthSummary(month: YearMonth, ctx: CalcContext) {
  const d = DateTime.fromISO(`${month}-01`, { zone: TIMEZONE });
  return summarize(iso(d.startOf("month")), iso(d.endOf("month")), ctx);
}

/** Año por curso ("2026-27") o natural ("2027"), según la vista elegida. */
export function annualSummary(key: string, ctx: CalcContext) {
  const { startsOn, endsOn } = annualBounds(key);
  return summarize(startsOn, endsOn, ctx);
}

export function annualKeyForToday(view: AnnualView, now: UtcDateTime) {
  return annualKeyOf(madridDateOf(now), view);
}

/** Desglose de un periodo en meses (para la vista anual). */
export function monthsOf(s: PeriodSummary): { month: YearMonth; summary: PeriodSummary }[] {
  const groups = new Map<YearMonth, DayResult[]>();
  for (const d of s.days) {
    const m = d.date.slice(0, 7);
    groups.set(m, [...(groups.get(m) ?? []), d]);
  }
  return [...groups.entries()].map(([month, days]) => ({ month, summary: fromDays(days) }));
}

/** Desglose de un periodo en semanas ISO (para la vista mensual). Las semanas de los extremos pueden ser parciales. */
export function weeksOf(s: PeriodSummary): { monday: CivilDate; summary: PeriodSummary }[] {
  const groups = new Map<CivilDate, DayResult[]>();
  for (const d of s.days) {
    const monday = iso(madrid(d.date).startOf("week"));
    groups.set(monday, [...(groups.get(monday) ?? []), d]);
  }
  return [...groups.entries()].map(([monday, days]) => ({ monday, summary: fromDays(days) }));
}

/** Recalcula un resumen a partir de días ya calculados (sin volver a partir fichajes). */
function fromDays(days: DayResult[]): PeriodSummary {
  const sum = (f: (d: DayResult) => number) => days.reduce((a, d) => a + f(d), 0);
  const workedHours = sum((d) => d.workedHours);
  const referenceToDate = sum((d) => (d.isFuture ? 0 : d.referenceHours));
  const diffHours = workedHours - referenceToDate;
  return {
    from: days[0]!.date, to: days[days.length - 1]!.date, days, workedHours, referenceToDate, diffHours,
    referenceHours: sum((d) => d.referenceHours),
    diffRatio: referenceToDate > 0 ? diffHours / referenceToDate : null,
    workedOnNonWorkdays: sum((d) => (d.referenceHours === 0 ? d.workedHours : 0)),
    workdays: days.filter((d) => d.referenceHours > 0).length,
    workdaysToDate: days.filter((d) => d.referenceHours > 0 && !d.isFuture).length,
    provisional: days.some((d) => d.provisional),
    pendingSessions: days.flatMap((d) => d.pendingSessions),
    undecidedDates: days.filter((d) => d.info.undecided.length > 0).map((d) => d.date),
    missingCourses: coursesWhere(days, (d) => d.info.missingCalendar),
    estimatedCourses: coursesWhere(days, (d) => d.info.estimatedCalendar),
  };
}

function coursesWhere(days: DayResult[], f: (d: DayResult) => boolean): CourseLabel[] {
  return [...new Set(days.filter(f).map((d) => coursesCovering(d.date, d.date)[0]!))].sort();
}

/** Calendarios reales más, si está activado, los estimados para los cursos que falten. */
export function effectiveCalendars(ctx: CalcContext, from: CivilDate, to: CivilDate): Calendars {
  return withEstimates(ctx.calendars, coursesCovering(from, to), ctx.config.estimateMissingCalendars, ctx.config.profile === "generico");
}

// ---------------------------------------------------------------------------
// Saldo del curso y traslado al siguiente
// ---------------------------------------------------------------------------

export interface CourseBalance {
  course: CourseLabel;
  summary: PeriodSummary;
  /** Saldo del propio curso (horas). */
  ownBalance: number;
  /** Horas traídas del curso anterior (0 si no hay traslado). */
  carriedIn: number;
  /** ownBalance + carriedIn. */
  totalBalance: number;
  /** ¿Ha terminado ya el curso? Solo entonces su saldo es definitivo. */
  finished: boolean;
}

export function courseBalance(course: CourseLabel, ctx: CalcContext, carryover: CarryoverFile | null): CourseBalance {
  const { startsOn, endsOn } = courseBounds(course);
  const summary = summarize(startsOn, endsOn, ctx);
  const carriedIn = carryover && carryover.course === course ? carryover.hours : 0;
  return {
    course, summary, carriedIn,
    ownBalance: summary.diffHours,
    totalBalance: summary.diffHours + carriedIn,
    finished: madridDateOf(ctx.now) > endsOn,
  };
}

/**
 * Traslado de saldo al curso siguiente. hours puede ser todo el saldo, una
 * parte o 0 (validateCarryoverFile comprueba que está entre 0 y el saldo).
 * El saldo que se traslada es el total del curso, incluido lo que él mismo trajo.
 */
export function buildCarryover(
  from: CourseBalance,
  toCourse: CourseLabel,
  hours: number,
  now: UtcDateTime,
  note?: string,
): CarryoverFile {
  return {
    schemaVersion: 1,
    course: toCourse,
    fromCourse: from.course,
    hours: round2(hours),
    sourceBalanceAtTransfer: round2(from.totalBalance),
    createdAt: now,
    updatedAt: now,
    note: note?.trim() || undefined,
  };
}

/**
 * ¿Ha cambiado el saldo del curso de origen desde el traslado (p. ej. por
 * corregir un fichaje antiguo)? Si es así, la app avisa y pregunta si se
 * actualiza el traslado; no lo cambia sola.
 */
export function carryoverDrift(carryover: CarryoverFile, currentSource: CourseBalance): { before: number; now: number } | null {
  const nowBal = round2(currentSource.totalBalance);
  return Math.abs(nowBal - carryover.sourceBalanceAtTransfer) >= 0.01
    ? { before: carryover.sourceBalanceAtTransfer, now: nowBal }
    : null;
}

// ---------------------------------------------------------------------------
// Cupos de vacaciones y permisos (por año natural, según config)
// ---------------------------------------------------------------------------

export interface LeaveUsage {
  category: LeaveCategory;
  periodKey: string;
  allowance: number;
  /** Días ya disfrutados (hasta hoy, incluido). */
  used: number;
  /** Días marcados en el futuro. */
  planned: number;
  /** Días gastados fuera de la app (configuración). */
  prior: number;
  remaining: number;
  usedDates: CivilDate[];
  plannedDates: CivilDate[];
  /** Cursos sin calendario dentro del periodo: el contador puede estar incompleto. */
  missingCourses: CourseLabel[];
  /** Cursos con calendario estimado: el contador es provisional. */
  estimatedCourses: CourseLabel[];
}

export function leaveUsage(category: LeaveCategory, periodKey: string, ctx: CalcContext): LeaveUsage {
  const { startsOn, endsOn } = annualBounds(periodKey);
  const term = termFor(startsOn, ctx.config) ?? firstTermWithin(startsOn, endsOn, ctx.config);
  const allowanceDef = term?.leaveAllowances.find((a) => a.category === category);
  const allowance = allowanceDef?.days ?? 0;
  const today = madridDateOf(ctx.now);
  const calendars = effectiveCalendars(ctx, startsOn, endsOn);
  const idx = indexByDate(calendars);
  const usedDates: CivilDate[] = [];
  const plannedDates: CivilDate[] = [];
  for (const date of eachDate(startsOn, endsOn)) {
    const info = dayInfo(date, ctx.config, calendars, idx);
    if (!info.consumesLeave || info.leave?.category !== category) continue;
    (date <= today ? usedDates : plannedDates).push(date);
  }
  const prior = ctx.config.priorLeaveUsage
    .filter((p) => p.category === category && p.periodKey === periodKey)
    .reduce((a, p) => a + p.days, 0);
  return {
    category, periodKey, allowance, prior, usedDates, plannedDates,
    used: usedDates.length,
    planned: plannedDates.length,
    remaining: allowance - prior - usedDates.length - plannedDates.length,
    missingCourses: coursesCovering(startsOn, endsOn).filter((c) => !calendars[c]),
    estimatedCourses: coursesCovering(startsOn, endsOn).filter((c) => !!calendars[c]?.estimatedFrom),
  };
}

function firstTermWithin(from: CivilDate, to: CivilDate, config: ConfigFile) {
  return [...config.contractTerms].sort((a, b) => a.validFrom.localeCompare(b.validFrom)).find((t) => t.validFrom >= from && t.validFrom <= to) ?? null;
}

// ---------------------------------------------------------------------------
// Aviso al cambiar el calendario: diferencia de referencia por semana
// ---------------------------------------------------------------------------

export interface WeekChange {
  monday: CivilDate;
  referenceBefore: number;
  referenceAfter: number;
  workedHours: number;
  diffBefore: number;
  diffAfter: number;
}

export function weekChanges(mondays: CivilDate[], ctx: CalcContext, after: Calendars): WeekChange[] {
  return mondays.map((monday) => {
    const b = weekSummary(monday, ctx);
    const a = weekSummary(monday, { ...ctx, calendars: after });
    return {
      monday, workedHours: b.workedHours,
      referenceBefore: b.referenceHours, referenceAfter: a.referenceHours,
      diffBefore: b.diffHours, diffAfter: a.diffHours,
    };
  });
}

// ---------------------------------------------------------------------------
// Formato para la interfaz (español)
// ---------------------------------------------------------------------------

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** 7.5 → "7 h 30 min"; con signo: "+1 h 05 min" / "−0 h 45 min". */
export function formatHours(h: number, signed = false): string {
  const totalMin = Math.round(Math.abs(h) * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  const sign = signed ? (h > 0 && totalMin > 0 ? "+" : h < 0 && totalMin > 0 ? "−" : "") : h < 0 && totalMin > 0 ? "−" : "";
  return `${sign}${hh} h ${String(mm).padStart(2, "0")} min`;
}

/** Formato compacto para tablas: 157.5 → "157:30"; con signo "+1:05". */
export function formatHoursShort(h: number, signed = false): string {
  const totalMin = Math.round(Math.abs(h) * 60);
  const sign = totalMin === 0 ? "" : h < 0 ? "−" : signed ? "+" : "";
  return `${sign}${Math.floor(totalMin / 60)}:${String(totalMin % 60).padStart(2, "0")}`;
}

/** 0.0533 → "+5,3 %"; null → "no aplica". */
export function formatRatio(r: number | null): string {
  if (r === null) return "no aplica";
  const v = Math.round(r * 1000) / 10;
  const s = Math.abs(v).toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${s} %`;
}
