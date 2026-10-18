import { DateTime } from "luxon";
import {
  CATEGORIES,
  SCHEMA_VERSION,
  TIMEZONE,
  type CalendarFile,
  type CarryoverFile,
  type ConfigFile,
  type SessionsFile,
  type WorkSession,
} from "./types";
import {
  courseBounds,
  isCivilDate,
  isCourseLabel,
  isLeavePeriodKey,
  isUtcDateTime,
  isYearMonth,
  madridMonthOf,
  previousCourse,
} from "./time";

/**
 * Validación de los ficheros leídos del repositorio y antes de escribirlos.
 * Devuelve la lista de errores (vacía = válido). Nunca se escribe un fichero
 * con errores, y un fichero remoto con errores no se sobrescribe a ciegas.
 */
export type ValidationErrors = string[];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function checkSchema(f: Record<string, unknown>, errs: ValidationErrors) {
  if (f.schemaVersion !== SCHEMA_VERSION) {
    errs.push(`schemaVersion ${String(f.schemaVersion)} no soportada (se esperaba ${SCHEMA_VERSION}).`);
  }
}

function checkSyncable(x: Record<string, unknown>, where: string, errs: ValidationErrors) {
  if (typeof x.id !== "string" || x.id.length === 0) errs.push(`${where}: falta id.`);
  if (!isUtcDateTime(x.updatedAt)) errs.push(`${where}: updatedAt no es una fecha-hora UTC válida.`);
  if (x.deleted !== undefined && typeof x.deleted !== "boolean") errs.push(`${where}: deleted debe ser booleano.`);
}

// ---------------------------------------------------------------------------

export function validateSessionsFile(f: unknown): ValidationErrors {
  const errs: ValidationErrors = [];
  if (!isObj(f)) return ["El fichero de fichajes no es un objeto JSON."];
  checkSchema(f, errs);
  if (!isYearMonth(f.month)) errs.push("month debe tener el formato AAAA-MM.");
  if (!Array.isArray(f.sessions)) return [...errs, "sessions debe ser una lista."];

  const ids = new Set<string>();
  const live: WorkSession[] = [];
  f.sessions.forEach((s: unknown, i: number) => {
    const where = `Fichaje #${i + 1}`;
    if (!isObj(s)) {
      errs.push(`${where}: no es un objeto.`);
      return;
    }
    checkSyncable(s, where, errs);
    if (typeof s.id === "string") {
      if (ids.has(s.id)) errs.push(`${where}: id repetido (${s.id}).`);
      ids.add(s.id);
    }
    if (!isUtcDateTime(s.start)) errs.push(`${where}: start no es una fecha-hora UTC válida.`);
    if (s.end !== null && !isUtcDateTime(s.end)) errs.push(`${where}: end debe ser null o una fecha-hora UTC válida.`);
    if (!["boton", "manual", "offline"].includes(s.origin as string)) errs.push(`${where}: origin no válido.`);
    if (s.note !== undefined && typeof s.note !== "string") errs.push(`${where}: note debe ser texto.`);
    if (isUtcDateTime(s.start) && typeof s.end === "string" && isUtcDateTime(s.end) && s.end <= s.start) {
      errs.push(`${where}: la salida debe ser posterior a la entrada.`);
    }
    if (isUtcDateTime(s.start) && isYearMonth(f.month) && madridMonthOf(s.start) !== f.month) {
      errs.push(`${where}: su entrada no cae en ${f.month} (hora de Madrid).`);
    }
    if (s.deleted !== true) live.push(s as unknown as WorkSession);
  });

  // Reglas sobre sesiones no borradas: como mucho una abierta y sin solapes.
  if (live.filter((s) => s.end === null).length > 1) {
    errs.push("Hay más de un fichaje abierto a la vez.");
  }
  errs.push(...findOverlaps(live));
  return errs;
}

/** Solapes entre sesiones (una abierta se considera que llega hasta el infinito). */
export function findOverlaps(sessions: WorkSession[]): ValidationErrors {
  const valid = sessions.filter((s) => isUtcDateTime(s.start) && (s.end === null || isUtcDateTime(s.end)));
  const sorted = [...valid].sort((a, b) => a.start.localeCompare(b.start));
  const errs: ValidationErrors = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.end === null || cur.start < prev.end) {
      errs.push(`Los fichajes ${prev.id} y ${cur.id} se solapan.`);
    }
  }
  return errs;
}

// ---------------------------------------------------------------------------

export function validateConfigFile(f: unknown): ValidationErrors {
  const errs: ValidationErrors = [];
  if (!isObj(f)) return ["config.json no es un objeto JSON."];
  checkSchema(f, errs);
  if (f.timezone !== TIMEZONE) errs.push(`timezone debe ser ${TIMEZONE}.`);
  if (!isUtcDateTime(f.updatedAt)) errs.push("updatedAt no es una fecha-hora UTC válida.");

  if (!Array.isArray(f.contractTerms) || f.contractTerms.length === 0) {
    errs.push("Debe haber al menos unas condiciones de contrato.");
  } else {
    const seen = new Set<string>();
    f.contractTerms.forEach((t: unknown, i: number) => {
      const where = `Contrato #${i + 1}`;
      if (!isObj(t)) {
        errs.push(`${where}: no es un objeto.`);
        return;
      }
      if (!isCivilDate(t.validFrom)) errs.push(`${where}: validFrom no es una fecha válida.`);
      else if (seen.has(t.validFrom)) errs.push(`${where}: validFrom repetido (${t.validFrom}).`);
      else seen.add(t.validFrom);
      if (typeof t.weeklyHours !== "number" || !(t.weeklyHours > 0) || t.weeklyHours > 168) {
        errs.push(`${where}: weeklyHours debe ser un número mayor que 0 y como mucho 168.`);
      }
      const wd = t.workdays;
      if (
        !Array.isArray(wd) ||
        wd.length === 0 ||
        new Set(wd).size !== wd.length ||
        !wd.every((d) => Number.isInteger(d) && d >= 1 && d <= 7)
      ) {
        errs.push(`${where}: workdays debe ser una lista sin repetidos de días 1 (lunes) a 7 (domingo).`);
      }
      const la = t.leaveAllowances;
      if (!Array.isArray(la)) {
        errs.push(`${where}: leaveAllowances debe ser una lista.`);
      } else {
        const cats = new Set<string>();
        la.forEach((a: unknown, j: number) => {
          const w = `${where}, cupo #${j + 1}`;
          if (!isObj(a)) return void errs.push(`${w}: no es un objeto.`);
          if (a.category !== "vacaciones_contrato" && a.category !== "permiso_personal") {
            errs.push(`${w}: categoría no válida.`);
          } else if (cats.has(a.category)) {
            errs.push(`${w}: categoría repetida.`);
          } else cats.add(a.category);
          if (typeof a.days !== "number" || !Number.isInteger(a.days) || a.days < 0 || a.days > 366) {
            errs.push(`${w}: days debe ser un número entero entre 0 y 366.`);
          }
          if (a.period !== "curso" && a.period !== "anio_natural") errs.push(`${w}: period debe ser "curso" o "anio_natural".`);
        });
      }
    });
  }

  if (!Array.isArray(f.priorLeaveUsage)) {
    errs.push("priorLeaveUsage debe ser una lista.");
  } else {
    const seenPrior = new Set<string>();
    f.priorLeaveUsage.forEach((u: unknown, i: number) => {
      const w = `Días previos #${i + 1}`;
      if (!isObj(u)) return void errs.push(`${w}: no es un objeto.`);
      if (!isLeavePeriodKey(u.periodKey)) errs.push(`${w}: periodKey debe ser un año (2026) o un curso (2026-27).`);
      if (u.category !== "vacaciones_contrato" && u.category !== "permiso_personal") errs.push(`${w}: categoría no válida.`);
      if (typeof u.days !== "number" || !Number.isInteger(u.days) || u.days < 0 || u.days > 366) {
        errs.push(`${w}: days debe ser un número entero entre 0 y 366.`);
      }
      const k = `${String(u.periodKey)}|${String(u.category)}`;
      if (seenPrior.has(k)) errs.push(`${w}: repetido para ese periodo y categoría.`);
      seenPrior.add(k);
    });
  }

  if (f.annualView !== "curso" && f.annualView !== "anio_natural") {
    errs.push('annualView debe ser "curso" o "anio_natural".');
  }

  if (f.trackingStartsOn !== null && !isCivilDate(f.trackingStartsOn)) errs.push("trackingStartsOn debe ser una fecha o null.");
  if (typeof f.estimateMissingCalendars !== "boolean") errs.push("estimateMissingCalendars debe ser booleano.");

  const ci = f.calendarImport;
  if (!isObj(ci) || typeof ci.campus !== "string" || !ci.campus.trim() || typeof ci.centre !== "string" || !ci.centre.trim()) {
    errs.push("calendarImport debe indicar campus y centro.");
  }

  const ex = f.export;
  if (!isObj(ex) || ![";", ","].includes(ex.csvSeparator as string) || typeof ex.decimalComma !== "boolean") {
    errs.push("export debe indicar csvSeparator (';' o ',') y decimalComma (booleano).");
  } else if (ex.csvSeparator === "," && ex.decimalComma === true) {
    errs.push("No se puede usar coma como separador y como decimal a la vez.");
  }
  return errs;
}

// ---------------------------------------------------------------------------

export function validateCalendarFile(f: unknown): ValidationErrors {
  const errs: ValidationErrors = [];
  if (!isObj(f)) return ["El calendario no es un objeto JSON."];
  checkSchema(f, errs);
  if (!isCourseLabel(f.course)) {
    errs.push("course debe tener el formato AAAA-AA (p. ej. 2026-27).");
    return errs;
  }
  const bounds = courseBounds(f.course);
  if (f.startsOn !== bounds.startsOn || f.endsOn !== bounds.endsOn) {
    errs.push(`El curso ${f.course} debe ir de ${bounds.startsOn} a ${bounds.endsOn}.`);
  }
  if (f.sourceName !== undefined && typeof f.sourceName !== "string") errs.push("sourceName debe ser texto.");
  if (f.estimatedFrom !== undefined) errs.push("Un calendario estimado no se puede guardar: importa o introduce el calendario real.");
  if (!Array.isArray(f.entries)) return [...errs, "entries debe ser una lista."];

  const ids = new Set<string>();
  const leaveDays = new Set<string>();
  f.entries.forEach((e: unknown, i: number) => {
    const where = `Fecha #${i + 1}`;
    if (!isObj(e)) {
      errs.push(`${where}: no es un objeto.`);
      return;
    }
    checkSyncable(e, where, errs);
    if (typeof e.id === "string") {
      if (ids.has(e.id)) errs.push(`${where}: id repetido (${e.id}).`);
      ids.add(e.id);
    }
    if (!isCivilDate(e.date)) errs.push(`${where}: date no es una fecha válida.`);
    else if (e.date < bounds.startsOn || e.date > bounds.endsOn) {
      errs.push(`${where}: ${e.date} está fuera del curso ${f.course}.`);
    }
    if (!CATEGORIES.includes(e.category as never)) errs.push(`${where}: categoría no válida.`);
    if (typeof e.isTransfer !== "boolean") errs.push(`${where}: isTransfer debe ser booleano.`);
    if (typeof e.origin !== "string" || e.origin.length === 0) errs.push(`${where}: falta el origen.`);
    if (e.isWorkingDay !== null && typeof e.isWorkingDay !== "boolean") {
      errs.push(`${where}: isWorkingDay debe ser true, false o null.`);
    }
    if (e.status !== "propuesta" && e.status !== "confirmada") errs.push(`${where}: status no válido.`);
    if (e.status === "confirmada" && e.isWorkingDay === null) {
      errs.push(`${where}: una fecha confirmada debe indicar si es laborable.`);
    }
    // Vacaciones y permisos: el día deja de ser laborable (referencia 0) y
    // consume cupo. Como mucho uno de estos por fecha.
    if (e.category === "vacaciones_contrato" || e.category === "permiso_personal") {
      if (e.isWorkingDay === true) errs.push(`${where}: unas vacaciones o un permiso no pueden ser día laborable.`);
      if (e.deleted !== true && typeof e.date === "string") {
        if (leaveDays.has(e.date)) errs.push(`${where}: ya hay vacaciones o un permiso el ${e.date}.`);
        leaveDays.add(e.date);
      }
    }
    // Un día de compensación consume saldo: su referencia debe mantenerse.
    if (e.category === "compensacion" && e.isWorkingDay === false) {
      errs.push(`${where}: un día de compensación debe contar como laborable para que consuma saldo.`);
    }
  });
  return errs;
}

// ---------------------------------------------------------------------------

export function validateCarryoverFile(f: unknown): ValidationErrors {
  const errs: ValidationErrors = [];
  if (!isObj(f)) return ["El traslado no es un objeto JSON."];
  checkSchema(f, errs);
  if (!isCourseLabel(f.course)) errs.push("course no válido.");
  if (!isCourseLabel(f.fromCourse)) errs.push("fromCourse no válido.");
  if (isCourseLabel(f.course) && isCourseLabel(f.fromCourse) && previousCourse(f.course) !== f.fromCourse) {
    errs.push(`Solo se puede trasladar desde el curso inmediatamente anterior a ${f.course}.`);
  }
  for (const k of ["hours", "sourceBalanceAtTransfer"] as const) {
    if (typeof f[k] !== "number" || !Number.isFinite(f[k])) errs.push(`${k} debe ser un número.`);
  }
  if (typeof f.hours === "number" && typeof f.sourceBalanceAtTransfer === "number") {
    const h = f.hours;
    const b = f.sourceBalanceAtTransfer;
    const inRange = b >= 0 ? h >= 0 && h <= b : h <= 0 && h >= b;
    if (!inRange) errs.push("Las horas trasladadas deben estar entre 0 y el saldo final del curso de origen.");
  }
  if (!isUtcDateTime(f.createdAt)) errs.push("createdAt no es una fecha-hora UTC válida.");
  if (!isUtcDateTime(f.updatedAt)) errs.push("updatedAt no es una fecha-hora UTC válida.");
  if (f.note !== undefined && typeof f.note !== "string") errs.push("note debe ser texto.");
  return errs;
}

/** Ayuda para mensajes: fecha UTC legible en hora de Madrid. */
export function formatMadrid(utc: string): string {
  return DateTime.fromISO(utc, { zone: "utc" }).setZone(TIMEZONE).toFormat("dd/MM/yyyy HH:mm");
}

export type { CalendarFile, CarryoverFile, ConfigFile, SessionsFile };
