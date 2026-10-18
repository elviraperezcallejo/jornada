import { DateTime } from "luxon";
import { newId } from "./ids";
import { madridDateOf, madridMonthOf, toMadrid } from "./time";
import { TIMEZONE, type CivilDate, type UtcDateTime, type WorkSession, type YearMonth } from "./types";

/**
 * Lógica pura de fichaje: estado actual y planificación de cada acción.
 * No toca red ni almacenamiento: devuelve qué hay que guardar o por qué no
 * se puede. Así se prueba sin GitHub y se reaplica igual tras un conflicto.
 */

/** Separación mínima entre dos pulsaciones del botón (evita dobles toques). Configurable. */
export const DEFAULT_MIN_GAP_SECONDS = 5;

export type ClockState =
  | { kind: "sin_fichar"; lastSession: WorkSession | null }
  | { kind: "fichado"; open: WorkSession }
  /** Abierto desde un día anterior: falta saber si se sale ahora o se olvidó fichar. */
  | { kind: "pendiente_revision"; open: WorkSession };

export type PlanError =
  | { code: "ya_fichado"; open: WorkSession }
  | { code: "no_fichado" }
  | { code: "pendiente_revision"; open: WorkSession }
  | { code: "requiere_confirmacion"; open: WorkSession }
  | { code: "demasiado_rapido"; seconds: number }
  | { code: "hora_futura" }
  | { code: "salida_no_posterior" }
  | { code: "solape"; with: WorkSession }
  | { code: "no_encontrado"; id: string };

/** Cambio a guardar: un fichaje completo (alta o modificación) en el fichero de su mes. */
export interface SessionOp {
  opId: string;
  month: YearMonth;
  session: WorkSession;
  /**
   * Versión (updatedAt) del fichaje sobre la que se hizo el cambio; null si
   * es nuevo. Al sincronizar, si en GitHub la versión es otra, alguien lo
   * cambió desde otro dispositivo: se marca conflicto en vez de pisarlo.
   */
  baseUpdatedAt: UtcDateTime | null;
  /** Para el mensaje del commit y el historial. */
  label: string;
}

export type Plan = { ok: true; ops: SessionOp[] } | { ok: false; error: PlanError };

export const live = (all: WorkSession[]) => all.filter((s) => !s.deleted);

const latestFirst = (a: WorkSession, b: WorkSession) => b.start.localeCompare(a.start);

export function clockState(all: WorkSession[], now: UtcDateTime): ClockState {
  const sessions = live(all);
  const open = sessions.filter((s) => s.end === null).sort(latestFirst)[0];
  if (open) {
    return madridDateOf(open.start) < madridDateOf(now)
      ? { kind: "pendiente_revision", open }
      : { kind: "fichado", open };
  }
  return { kind: "sin_fichar", lastSession: [...sessions].sort(latestFirst)[0] ?? null };
}

/** Instante de la última pulsación registrada (entrada o salida). */
function lastEventAt(all: WorkSession[]): UtcDateTime | null {
  let last: UtcDateTime | null = null;
  for (const s of live(all)) {
    for (const t of [s.start, s.end]) if (t && (!last || t > last)) last = t;
  }
  return last;
}

function tooFast(all: WorkSession[], now: UtcDateTime, minGapSeconds: number): PlanError | null {
  const last = lastEventAt(all);
  if (!last) return null;
  const secs = (Date.parse(now) - Date.parse(last)) / 1000;
  return secs >= 0 && secs < minGapSeconds ? { code: "demasiado_rapido", seconds: minGapSeconds } : null;
}

/** Primer fichaje que se solapa con [start, end) (end null = hasta el infinito). */
export function findOverlap(all: WorkSession[], start: UtcDateTime, end: UtcDateTime | null, ignoreId?: string) {
  return live(all).find((s) => {
    if (s.id === ignoreId) return false;
    const sEndsAfterStart = s.end === null || s.end > start;
    const startsBeforeEnd = end === null || s.start < end;
    return sEndsAfterStart && startsBeforeEnd;
  });
}

const fmt = (utc: UtcDateTime) => toMadrid(utc).toFormat("dd/MM/yyyy HH:mm");

function op(session: WorkSession, label: string, base: WorkSession | null): SessionOp {
  return { opId: newId(), month: madridMonthOf(session.start), session, baseUpdatedAt: base?.updatedAt ?? null, label };
}

// ---------------------------------------------------------------------------
// Botón Entrar / Salir
// ---------------------------------------------------------------------------

export interface ToggleOptions {
  now: UtcDateTime;
  /** true si se pulsa sin conexión (queda como origen "offline"). */
  offline?: boolean;
  minGapSeconds?: number;
  /**
   * Solo para un fichaje pendiente de revisión (abierto desde otro día):
   * - "ahora": confirma que se sale ahora (cruce de medianoche real);
   * - una hora UTC: la salida real que se olvidó fichar.
   */
  resolution?: "ahora" | UtcDateTime;
}

/** Pulsación del botón: entra si no hay fichaje abierto, sale si lo hay. */
export function planToggle(all: WorkSession[], o: ToggleOptions): Plan {
  const state = clockState(all, o.now);
  return state.kind === "sin_fichar" ? planClockIn(all, o) : planClockOut(all, o);
}

export function planClockIn(all: WorkSession[], o: ToggleOptions): Plan {
  const state = clockState(all, o.now);
  if (state.kind === "fichado") return { ok: false, error: { code: "ya_fichado", open: state.open } };
  if (state.kind === "pendiente_revision") return { ok: false, error: { code: "pendiente_revision", open: state.open } };
  const fast = tooFast(all, o.now, o.minGapSeconds ?? DEFAULT_MIN_GAP_SECONDS);
  if (fast) return { ok: false, error: fast };
  const clash = findOverlap(all, o.now, null);
  if (clash) return { ok: false, error: { code: "solape", with: clash } };
  const session: WorkSession = {
    id: newId(),
    updatedAt: o.now,
    start: o.now,
    end: null,
    origin: o.offline ? "offline" : "boton",
  };
  return { ok: true, ops: [op(session, `Entrada ${fmt(o.now)}`, null)] };
}

export function planClockOut(all: WorkSession[], o: ToggleOptions): Plan {
  const state = clockState(all, o.now);
  if (state.kind === "sin_fichar") return { ok: false, error: { code: "no_fichado" } };
  const open = state.open;

  let end: UtcDateTime;
  if (state.kind === "pendiente_revision") {
    // Nunca se inventa la hora: hace falta la decisión del usuario.
    if (!o.resolution) return { ok: false, error: { code: "requiere_confirmacion", open } };
    end = o.resolution === "ahora" ? o.now : o.resolution;
  } else {
    const fast = tooFast(all, o.now, o.minGapSeconds ?? DEFAULT_MIN_GAP_SECONDS);
    if (fast) return { ok: false, error: fast };
    end = o.now;
  }
  if (end > o.now) return { ok: false, error: { code: "hora_futura" } };
  if (end <= open.start) return { ok: false, error: { code: "salida_no_posterior" } };
  const clash = findOverlap(all, open.start, end, open.id);
  if (clash) return { ok: false, error: { code: "solape", with: clash } };

  const session: WorkSession = { ...open, end, updatedAt: o.now };
  if (o.offline && session.origin === "boton") session.origin = "offline";
  return { ok: true, ops: [op(session, `Salida ${fmt(end)}`, open)] };
}

// ---------------------------------------------------------------------------
// Historial: añadir, corregir y eliminar
// ---------------------------------------------------------------------------

export interface ManualInput {
  start: UtcDateTime;
  /** null solo si se quiere dejar abierto (p. ej. corregir la hora de entrada de hoy). */
  end: UtcDateTime | null;
  note?: string;
}

function checkManual(all: WorkSession[], i: ManualInput, now: UtcDateTime, ignoreId?: string): PlanError | null {
  if (i.start > now || (i.end !== null && i.end > now)) return { code: "hora_futura" };
  if (i.end !== null && i.end <= i.start) return { code: "salida_no_posterior" };
  if (i.end === null) {
    const otherOpen = live(all).find((s) => s.end === null && s.id !== ignoreId);
    if (otherOpen) return { code: "ya_fichado", open: otherOpen };
  }
  const clash = findOverlap(all, i.start, i.end, ignoreId);
  return clash ? { code: "solape", with: clash } : null;
}

const cleanNote = (n?: string) => (n && n.trim() ? n.trim() : undefined);

/** Añadir un fichaje olvidado. */
export function planAdd(all: WorkSession[], i: ManualInput, now: UtcDateTime): Plan {
  const err = checkManual(all, i, now);
  if (err) return { ok: false, error: err };
  const session: WorkSession = {
    id: newId(), updatedAt: now, start: i.start, end: i.end, origin: "manual", note: cleanNote(i.note),
  };
  return { ok: true, ops: [op(session, `Fichaje añadido ${fmt(i.start)}`, null)] };
}

/**
 * Corregir un fichaje. Si la nueva entrada cae en otro mes, el fichaje se
 * mueve de fichero: se borra (lápida) en el antiguo y se crea en el nuevo
 * con otro id, para que nunca haya dos fichajes vivos con el mismo id.
 */
export function planEdit(all: WorkSession[], id: string, i: ManualInput, now: UtcDateTime): Plan {
  const old = live(all).find((s) => s.id === id);
  if (!old) return { ok: false, error: { code: "no_encontrado", id } };
  const err = checkManual(all, i, now, id);
  if (err) return { ok: false, error: err };
  const changed: WorkSession = { ...old, start: i.start, end: i.end, note: cleanNote(i.note), updatedAt: now };
  if (madridMonthOf(i.start) === madridMonthOf(old.start)) {
    return { ok: true, ops: [op(changed, `Fichaje corregido ${fmt(i.start)}`, old)] };
  }
  const moved: WorkSession = { ...changed, id: newId() };
  const tomb: WorkSession = { ...old, deleted: true, updatedAt: now };
  // Primero se crea el nuevo y después se borra el viejo: si algo falla a
  // medias, se ve un duplicado (recuperable) en vez de perder el fichaje.
  return {
    ok: true,
    ops: [op(moved, `Fichaje movido a ${fmt(i.start)}`, null), op(tomb, `Fichaje movido desde ${fmt(old.start)}`, old)],
  };
}

/** Eliminar (la interfaz pide confirmación antes). Se guarda como lápida. */
export function planDelete(all: WorkSession[], id: string, now: UtcDateTime): Plan {
  const old = live(all).find((s) => s.id === id);
  if (!old) return { ok: false, error: { code: "no_encontrado", id } };
  return { ok: true, ops: [op({ ...old, deleted: true, updatedAt: now }, `Fichaje eliminado ${fmt(old.start)}`, old)] };
}

// ---------------------------------------------------------------------------
// Consulta para el historial
// ---------------------------------------------------------------------------

/**
 * Fichajes que tocan un día civil de Madrid, incluidos los que empiezan el
 * día anterior y terminan en este (cruce de medianoche) y los abiertos.
 */
export function sessionsTouchingDay(all: WorkSession[], day: CivilDate, now: UtcDateTime): WorkSession[] {
  const dayStart = DateTime.fromISO(day, { zone: TIMEZONE }).startOf("day").toUTC().toISO()!;
  const dayEnd = DateTime.fromISO(day, { zone: TIMEZONE }).plus({ days: 1 }).startOf("day").toUTC().toISO()!;
  return live(all)
    .filter((s) => {
      const end = s.end ?? (madridDateOf(s.start) === madridDateOf(now) ? now : s.start);
      return s.start < dayEnd && (end > dayStart || s.start >= dayStart);
    })
    .sort((a, b) => a.start.localeCompare(b.start));
}

/** Mensaje en español para cada error, para la interfaz. */
export function describeError(e: PlanError): string {
  switch (e.code) {
    case "ya_fichado": return `Ya hay una entrada abierta desde ${fmt(e.open.start)}.`;
    case "no_fichado": return "No hay ninguna entrada abierta.";
    case "pendiente_revision":
      return `La entrada del ${fmt(e.open.start)} sigue abierta. Indica primero cuándo saliste.`;
    case "requiere_confirmacion":
      return `La entrada fue el ${fmt(e.open.start)}. ¿Sales ahora o olvidaste fichar la salida?`;
    case "demasiado_rapido": return `Acabas de fichar. Espera ${e.seconds} segundos para evitar dobles pulsaciones.`;
    case "hora_futura": return "La hora no puede ser posterior a ahora.";
    case "salida_no_posterior": return "La salida debe ser posterior a la entrada.";
    case "solape": return `Se solapa con el fichaje del ${fmt(e.with.start)}.`;
    case "no_encontrado": return "Ese fichaje ya no existe (quizá se borró desde otro dispositivo).";
  }
}

// ---------------------------------------------------------------------------
// Aplicar cambios y comprobar reglas globales (entre ficheros de varios meses)
// ---------------------------------------------------------------------------

/** Sustituye o añade un fichaje por id. */
export function upsert(list: WorkSession[], s: WorkSession): WorkSession[] {
  const i = list.findIndex((x) => x.id === s.id);
  if (i === -1) return [...list, s];
  const copy = [...list];
  copy[i] = s;
  return copy;
}

/**
 * Reglas que un único fichero mensual no puede comprobar: como mucho un
 * fichaje abierto en total y sin solapes entre meses (p. ej. uno que cruza
 * la medianoche del 31 al 1).
 */
export function globalErrors(all: WorkSession[]): string[] {
  const sessions = live(all);
  const errs: string[] = [];
  if (sessions.filter((s) => s.end === null).length > 1) errs.push("Habría más de un fichaje abierto a la vez.");
  const sorted = [...sessions].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.end === null || cur.start < prev.end) {
      errs.push(`Se solaparían los fichajes del ${fmt(prev.start)} y del ${fmt(cur.start)}.`);
    }
  }
  return errs;
}
