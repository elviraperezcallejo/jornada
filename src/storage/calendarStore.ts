import {
  affectedWeeks,
  applyCalendarOp,

  laborabilityChanges,
  type CalendarOp,
  type CalendarPlan,
  type Calendars,
  type DayChange,
} from "../domain/calendar";
import { isCourseLabel, nowUtc } from "../domain/time";
import type { CalendarEntry, CalendarFile, CivilDate, ConfigFile, CourseLabel, UtcDateTime } from "../domain/types";
import { validateCalendarFile } from "../domain/validate";
import type { ProposedItem } from "../import/parseUvaCalendar";
import { AuthError, ForbiddenError, InvalidDataError, NetworkError, StorageError } from "./errors";
import type { LocalStore } from "./local";
import { calendarPath } from "./paths";
import type { DataRepository } from "./repository";
import type { SyncStatus } from "./sessionStore";

/**
 * Calendarios por curso, con el mismo esquema que los fichajes: primero en
 * local, envío a GitHub cuando hay conexión y conflictos en vez de pisar.
 * Cada acción del usuario (confirmar una importación, añadir unas
 * vacaciones…) es un único commit.
 */

interface CachedCalendar {
  sha: string;
  data: CalendarFile;
}

export interface CalendarConflict {
  op: CalendarOp;
  reason: string;
  detectedAt: UtcDateTime;
}

/** Importación en revisión: se guarda solo en el dispositivo hasta confirmarla. */
export interface ImportDraft {
  course: CourseLabel;
  sourceName: string;
  items: ProposedItem[];
  /** Fechas propuestas (una por día, ids estables) que se revisan en la vista mensual. */
  entries: CalendarEntry[];
  warnings: string[];
  createdAt: UtcDateTime;
}

export interface ChangePreview {
  changes: DayChange[];
  /** Lunes de cada semana cuya referencia de horas cambiaría. */
  weeks: CivilDate[];
}

const K = {
  cache: "calendars.cache.v1",
  queue: "calendars.queue.v1",
  conflicts: "calendars.conflicts.v1",
  draft: "calendars.importDraft.v1",
};

class StaleError extends Error {}

export class CalendarStore {
  private files: Record<CourseLabel, CachedCalendar> = {};
  private queue: CalendarOp[] = [];
  private conflicts: CalendarConflict[] = [];
  private flushing: Promise<SyncStatus> | null = null;

  constructor(
    private readonly local: LocalStore,
    private repo: DataRepository | null,
    private readonly now: () => UtcDateTime = nowUtc,
  ) {}

  async init() {
    this.files = (await this.local.get<Record<CourseLabel, CachedCalendar>>(K.cache)) ?? {};
    this.queue = (await this.local.get<CalendarOp[]>(K.queue)) ?? [];
    this.conflicts = (await this.local.get<CalendarConflict[]>(K.conflicts)) ?? [];
  }

  setRepository(repo: DataRepository | null) {
    this.repo = repo;
  }

  private remote(): Calendars {
    const out: Calendars = {};
    for (const [c, f] of Object.entries(this.files)) out[c] = f.data;
    return out;
  }

  /** Calendarios tal y como los ve el usuario (incluye cambios pendientes de enviar). */
  calendars(): Calendars {
    const out = this.remote();
    for (const op of this.queue) out[op.course] = applyCalendarOp(out[op.course] ?? null, op);
    return out;
  }

  calendar(course: CourseLabel): CalendarFile | null {
    return this.calendars()[course] ?? null;
  }

  pendingCount() {
    return this.queue.length;
  }

  getConflicts() {
    return [...this.conflicts];
  }

  async dismissConflict(opId: string) {
    this.conflicts = this.conflicts.filter((c) => c.op.opId !== opId);
    await this.local.set(K.conflicts, this.conflicts);
  }

  // ----- Borrador de importación (solo en el dispositivo) -----

  saveDraft(d: ImportDraft) {
    return this.local.set(K.draft, d);
  }
  loadDraft() {
    return this.local.get<ImportDraft>(K.draft);
  }
  clearDraft() {
    return this.local.del(K.draft);
  }

  // ----- Cambios -----

  /**
   * Qué semanas cambiarían de referencia si se aplica el cambio. La interfaz
   * lo muestra ANTES de guardar; como los totales se recalculan siempre a
   * partir de los datos, al guardar quedan actualizados.
   */
  preview(plan: CalendarPlan, config: ConfigFile): ChangePreview | null {
    if (!plan.ok) return null;
    const before = this.calendars();
    const after = { ...before, [plan.op.course]: applyCalendarOp(before[plan.op.course] ?? null, plan.op) };
    const touched = new Set<CivilDate>();
    for (const e of plan.op.entries) touched.add(e.date);
    const changes = laborabilityChanges(config, before, after, [...touched].sort());
    return { changes, weeks: affectedWeeks(changes) };
  }

  async apply(plan: CalendarPlan): Promise<{ ok: true; sync: SyncStatus } | { ok: false; errors: string[] }> {
    if (!plan.ok) return plan;
    this.queue.push(plan.op);
    await this.local.set(K.queue, this.queue);
    return { ok: true, sync: await this.flush() };
  }

  flush(): Promise<SyncStatus> {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  /** Descarga los calendarios que han cambiado. */
  async pull(): Promise<void> {
    if (!this.repo) return;
    const dirs = (await this.repo.listDir("cursos")).filter((e) => e.type === "dir" && isCourseLabel(e.name));
    const seen = new Set<CourseLabel>();
    for (const d of dirs) {
      const file = (await this.repo.listDir(`cursos/${d.name}`)).find((e) => e.name === "calendario.json");
      if (!file) continue;
      seen.add(d.name);
      if (this.files[d.name]?.sha === file.sha) continue;
      const loaded = await this.repo.read<CalendarFile>(calendarPath(d.name), validateCalendarFile);
      if (loaded) this.files[d.name] = { sha: loaded.sha, data: loaded.data };
    }
    for (const c of Object.keys(this.files)) if (!seen.has(c)) delete this.files[c];
    await this.local.set(K.cache, this.files);
  }

  private async doFlush(): Promise<SyncStatus> {
    if (!this.repo) return { kind: "sin_conexion_configurada" };
    const repo = this.repo;
    try {
      await this.pull();
      while (this.queue.length) {
        const op = this.queue[0]!;
        try {
          const saved = await repo.update<CalendarFile>(
            calendarPath(op.course),
            validateCalendarFile,
            (cur) => applyChecked(cur, op),
            op.label,
          );
          this.files[op.course] = { sha: saved.sha, data: saved.data };
          this.queue.shift();
          await this.local.set(K.cache, this.files);
          await this.local.set(K.queue, this.queue);
        } catch (e) {
          if (e instanceof StaleError || e instanceof InvalidDataError) {
            this.conflicts.push({ op, reason: e.message, detectedAt: this.now() });
            this.queue.shift();
            await this.local.set(K.conflicts, this.conflicts);
            await this.local.set(K.queue, this.queue);
            await this.pull();
            continue;
          }
          throw e;
        }
      }
      return { kind: "sincronizado" };
    } catch (e) {
      if (e instanceof NetworkError) return { kind: "pendiente", pending: this.queue.length, reason: "sin_red" };
      if (e instanceof AuthError || e instanceof ForbiddenError) return { kind: "credenciales", message: e.message };
      const message = e instanceof StorageError ? e.message : String(e);
      return { kind: "pendiente", pending: this.queue.length, reason: "error", message };
    }
  }
}

/** Aplica el lote comprobando que ninguna fecha cambió desde que se preparó. */
function applyChecked(cur: CalendarFile | null, op: CalendarOp): CalendarFile {
  for (const e of op.entries) {
    const now = cur?.entries.find((x) => x.id === e.id) ?? null;
    if (now && JSON.stringify(now) === JSON.stringify(e)) continue; // ya aplicado
    if ((now?.updatedAt ?? null) !== op.bases[e.id]) {
      throw new StaleError(`La fecha ${e.date} se modificó desde otro dispositivo antes de guardar este cambio.`);
    }
  }
  return applyCalendarOp(cur, op);
}

