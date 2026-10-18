import {
  clockState,
  globalErrors,
  live,
  planAdd,
  planDelete,
  planEdit,
  planToggle,
  upsert,
  type ClockState,
  type ManualInput,
  type Plan,
  type PlanError,
  type SessionOp,
  type ToggleOptions,
} from "../domain/sessions";
import { nowUtc, isYearMonth } from "../domain/time";
import { SCHEMA_VERSION, type SessionsFile, type UtcDateTime, type WorkSession, type YearMonth } from "../domain/types";
import { validateSessionsFile } from "../domain/validate";
import { AuthError, ForbiddenError, InvalidDataError, NetworkError, StorageError } from "./errors";
import type { LocalStore } from "./local";
import { sessionsPath } from "./paths";
import type { DataRepository } from "./repository";

/**
 * Fichajes "primero en local":
 * - cada acción se valida, se guarda en una cola local y se ve al instante;
 * - después se envía a GitHub (ahora, o cuando vuelva la conexión);
 * - si al enviarla GitHub tiene una versión distinta del mismo fichaje, o la
 *   acción ya no cumple las reglas (p. ej. otro dispositivo fichó la entrada
 *   antes), NO se pisa nada: la acción pasa a "conflictos" para revisarla.
 */

interface CachedFile {
  sha: string;
  data: SessionsFile;
}

export interface Conflict {
  op: SessionOp;
  /** Versión que hay en GitHub del mismo fichaje (si existe). */
  remote: WorkSession | null;
  reason: string;
  detectedAt: UtcDateTime;
}

export type SyncStatus =
  | { kind: "sin_conexion_configurada" }
  | { kind: "sincronizado" }
  | { kind: "pendiente"; pending: number; reason: "sin_red" | "error"; message?: string }
  | { kind: "credenciales"; message: string };

export type ActionResult = { ok: true; sync: SyncStatus } | { ok: false; error: PlanError };

const K = { cache: "sessions.cache.v1", queue: "sessions.queue.v1", conflicts: "sessions.conflicts.v1" };
const DIR = "fichajes";

class StaleError extends Error {}

export class SessionStore {
  private files: Record<YearMonth, CachedFile> = {};
  private queue: SessionOp[] = [];
  private conflicts: Conflict[] = [];
  private flushing: Promise<SyncStatus> | null = null;

  constructor(
    private readonly local: LocalStore,
    private repo: DataRepository | null,
    private readonly now: () => UtcDateTime = nowUtc,
  ) {}

  /** Carga el estado guardado en el dispositivo (funciona sin conexión). */
  async init(): Promise<void> {
    this.files = (await this.local.get<Record<YearMonth, CachedFile>>(K.cache)) ?? {};
    this.queue = (await this.local.get<SessionOp[]>(K.queue)) ?? [];
    this.conflicts = (await this.local.get<Conflict[]>(K.conflicts)) ?? [];
  }

  setRepository(repo: DataRepository | null) {
    this.repo = repo;
  }

  // -------------------------------------------------------------------------
  // Lectura
  // -------------------------------------------------------------------------

  /** Fichajes confirmados en GitHub (última copia descargada). */
  private remoteAll(): WorkSession[] {
    return Object.values(this.files).flatMap((f) => f.data.sessions);
  }

  /** Lo que ve el usuario: lo de GitHub más los cambios aún pendientes de enviar. */
  all(): WorkSession[] {
    let list = this.remoteAll();
    for (const op of this.queue) list = upsert(list, op.session);
    return list;
  }

  liveSessions(): WorkSession[] {
    return live(this.all());
  }

  state(): ClockState {
    return clockState(this.all(), this.now());
  }

  pendingCount(): number {
    return this.queue.length;
  }

  getConflicts(): Conflict[] {
    return [...this.conflicts];
  }

  /** El usuario ya ha revisado un conflicto (rehaciendo el cambio si quería). */
  async dismissConflict(opId: string): Promise<void> {
    this.conflicts = this.conflicts.filter((c) => c.op.opId !== opId);
    await this.local.set(K.conflicts, this.conflicts);
  }

  // -------------------------------------------------------------------------
  // Acciones
  // -------------------------------------------------------------------------

  toggle(o: Omit<ToggleOptions, "now"> = {}): Promise<ActionResult> {
    return this.perform(planToggle(this.all(), { ...o, now: this.now() }));
  }

  add(i: ManualInput): Promise<ActionResult> {
    return this.perform(planAdd(this.all(), i, this.now()));
  }

  edit(id: string, i: ManualInput): Promise<ActionResult> {
    return this.perform(planEdit(this.all(), id, i, this.now()));
  }

  remove(id: string): Promise<ActionResult> {
    return this.perform(planDelete(this.all(), id, this.now()));
  }

  private async perform(plan: Plan): Promise<ActionResult> {
    if (!plan.ok) return plan;
    this.queue.push(...plan.ops);
    await this.local.set(K.queue, this.queue); // primero a disco local: no se pierde aunque se cierre la app
    return { ok: true, sync: await this.flush() };
  }

  // -------------------------------------------------------------------------
  // Sincronización
  // -------------------------------------------------------------------------

  /** Envía la cola a GitHub. Si ya se está enviando, espera a ese envío. */
  flush(): Promise<SyncStatus> {
    if (!this.flushing) {
      this.flushing = this.doFlush().finally(() => {
        this.flushing = null;
      });
    }
    return this.flushing;
  }

  /** Descarga solo los meses cuyo sha ha cambiado desde la última vez. */
  async pull(): Promise<void> {
    if (!this.repo) return;
    const entries = await this.repo.listDir(DIR);
    const seen = new Set<YearMonth>();
    for (const e of entries) {
      if (e.type !== "file") continue;
      const month = e.name.replace(/\.json$/, "");
      if (!isYearMonth(month)) continue;
      seen.add(month);
      if (this.files[month]?.sha === e.sha) continue;
      const loaded = await this.repo.read<SessionsFile>(sessionsPath(month), validateSessionsFile);
      if (loaded) this.files[month] = { sha: loaded.sha, data: loaded.data };
    }
    for (const m of Object.keys(this.files)) if (!seen.has(m)) delete this.files[m];
    await this.local.set(K.cache, this.files);
  }

  private async doFlush(): Promise<SyncStatus> {
    if (!this.repo) return { kind: "sin_conexion_configurada" };
    const repo = this.repo;
    try {
      await this.pull();
      while (this.queue.length) {
        const op = this.queue[0]!;
        const problem = this.checkAgainstRemote(op);
        if (problem) {
          await this.toConflict(op, problem);
          continue;
        }
        try {
          const saved = await repo.update<SessionsFile>(
            sessionsPath(op.month),
            validateSessionsFile,
            (cur) => applyOp(cur ?? emptyMonth(op.month), op),
            op.label,
          );
          this.files[op.month] = { sha: saved.sha, data: saved.data };
          this.queue.shift();
          await this.local.set(K.cache, this.files);
          await this.local.set(K.queue, this.queue);
        } catch (e) {
          if (e instanceof StaleError || e instanceof InvalidDataError) {
            await this.pull(); // para mostrar la versión real en el conflicto
            await this.toConflict(op, e.message);
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

  /** ¿Sigue teniendo sentido el cambio frente a lo que hay ahora en GitHub? */
  private checkAgainstRemote(op: SessionOp): string | null {
    const remote = this.remoteAll();
    const current = remote.find((s) => s.id === op.session.id) ?? null;
    if (current && sameSession(current, op.session)) return null; // ya aplicado
    if ((current?.updatedAt ?? null) !== op.baseUpdatedAt) {
      return current
        ? "Este fichaje se modificó desde otro dispositivo antes de que se enviara este cambio."
        : "Este fichaje ya no existe en GitHub.";
    }
    const errs = globalErrors(upsert(remote, op.session));
    return errs.length ? errs.join(" ") : null;
  }

  private async toConflict(op: SessionOp, reason: string) {
    const remote = this.remoteAll().find((s) => s.id === op.session.id) ?? null;
    this.conflicts.push({ op, remote, reason, detectedAt: this.now() });
    this.queue.shift();
    await this.local.set(K.conflicts, this.conflicts);
    await this.local.set(K.queue, this.queue);
  }
}

function emptyMonth(month: YearMonth): SessionsFile {
  return { schemaVersion: SCHEMA_VERSION, month, sessions: [] };
}

function sameSession(a: WorkSession, b: WorkSession) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Aplica el cambio sobre la versión recién leída; se reejecuta si hay conflicto de escritura. */
function applyOp(file: SessionsFile, op: SessionOp): SessionsFile {
  const current = file.sessions.find((s) => s.id === op.session.id) ?? null;
  if (current && sameSession(current, op.session)) return file;
  if ((current?.updatedAt ?? null) !== op.baseUpdatedAt) {
    throw new StaleError("Este fichaje se modificó desde otro dispositivo mientras se guardaba.");
  }
  return { ...file, sessions: upsert(file.sessions, op.session) };
}
