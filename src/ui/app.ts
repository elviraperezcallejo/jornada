import type { CalcContext } from "../domain/compute";
import { madridDateOf, nowUtc } from "../domain/time";
import type { CarryoverFile, CourseLabel } from "../domain/types";
import { CalendarStore } from "../storage/calendarStore";
import { readCarryover } from "../storage/carryover";
import { ConfigStore } from "../storage/configStore";
import { connect } from "../storage/connection";
import { clearConnection, loadConnection, saveConnection, tokenStatus, type ConnectionSettings } from "../storage/credentials";
import { StorageError } from "../storage/errors";
import { IdbStore, type LocalStore } from "../storage/local";
import type { DataRepository } from "../storage/repository";
import { SessionStore, type SyncStatus } from "../storage/sessionStore";

export type Route = "fichar" | "historial" | "resumen" | "calendario" | "ajustes" | "conflictos";

export interface SyncView {
  kind: "local" | "ok" | "pendiente" | "sin_red" | "credenciales" | "error" | "sincronizando";
  message?: string;
}

/**
 * Estado de la aplicación: almacenes, conexión y sincronización.
 * Las vistas leen de aquí y piden a render() que se redibuje.
 */
export class App {
  readonly local: LocalStore;
  readonly sessions: SessionStore;
  readonly calendars: CalendarStore;
  readonly config: ConfigStore;
  repo: DataRepository | null = null;
  connection: ConnectionSettings | null = null;
  sync: SyncView = { kind: "local" };
  carryovers: Partial<Record<CourseLabel, CarryoverFile | null>> = {};
  private renderFn: (background: boolean) => void = () => {};
  private syncing: Promise<void> | null = null;

  constructor(local: LocalStore = new IdbStore(), readonly kv: Storage = window.localStorage) {
    this.local = local;
    this.sessions = new SessionStore(local, null);
    this.calendars = new CalendarStore(local, null);
    this.config = new ConfigStore(local);
  }

  onRender(fn: (background: boolean) => void) {
    this.renderFn = fn;
  }
  /** Redibuja ya (acción del usuario). */
  render() {
    this.renderFn(false);
  }
  /** Redibuja por algo que pasa de fondo (sincronización): espera si el usuario está escribiendo. */
  renderBackground() {
    this.renderFn(true);
  }

  async start() {
    await Promise.all([this.sessions.init(), this.calendars.init(), this.config.init()]);
    this.connection = loadConnection(this.kv);
    this.renderBackground();
    if (this.connection) await this.connectWith(this.connection, false).catch(() => undefined);
    window.addEventListener("online", () => void this.syncNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") void this.syncNow();
    });
  }

  /** Conecta con el repositorio privado. Lanza un error comprensible si algo falla. */
  async connectWith(settings: ConnectionSettings, persist = true) {
    try {
      const { repository, result } = await connect(settings);
      this.repo = repository;
      this.connection = settings;
      if (persist) saveConnection(this.kv, settings);
      this.sessions.setRepository(repository);
      this.calendars.setRepository(repository);
      this.config.setRepository(repository);
      if (!this.config.hasPending()) await this.config.setRemote(result.config);
      await this.syncNow();
    } catch (e) {
      this.sync = { kind: "error", message: e instanceof StorageError ? e.message : String(e) };
      this.render();
      throw e;
    }
  }

  forgetConnection() {
    clearConnection(this.kv);
    this.connection = null;
    this.repo = null;
    this.sessions.setRepository(null);
    this.calendars.setRepository(null);
    this.config.setRepository(null);
    this.sync = { kind: "local" };
    this.render();
  }

  /** Envía lo pendiente y descarga lo nuevo. */
  syncNow(): Promise<void> {
    if (!this.repo) {
      this.sync = { kind: "local" };
      this.renderBackground();
      return Promise.resolve();
    }
    if (!this.syncing) {
      this.syncing = (async () => {
        this.sync = { kind: "sincronizando" };
        this.renderBackground();
        const cfg = await this.config.flush();
        const a = await this.sessions.flush();
        const b = await this.calendars.flush();
        this.sync = this.merge(cfg.ok ? null : cfg, a, b);
        this.renderBackground();
      })().finally(() => {
        this.syncing = null;
      });
    }
    return this.syncing;
  }

  /** Estado de la sincronización después de una acción. */
  afterAction(s: SyncStatus) {
    this.sync = this.merge(null, s);
    this.render();
  }

  private merge(cfg: { kind: string; message: string } | null, ...all: SyncStatus[]): SyncView {
    if (cfg?.kind === "credenciales" || all.some((s) => s.kind === "credenciales")) {
      const m = all.find((s) => s.kind === "credenciales");
      return { kind: "credenciales", message: m && "message" in m ? m.message : cfg?.message };
    }
    if (cfg?.kind === "sin_red" || all.some((s) => s.kind === "pendiente" && s.reason === "sin_red")) return { kind: "sin_red" };
    const err = all.find((s) => s.kind === "pendiente" && s.reason === "error");
    if (err && err.kind === "pendiente") return { kind: "error", message: err.message };
    if (cfg) return { kind: "error", message: cfg.message };
    if (all.some((s) => s.kind === "sin_conexion_configurada")) return { kind: "local" };
    return this.pendingCount() ? { kind: "pendiente" } : { kind: "ok" };
  }

  pendingCount() {
    return this.sessions.pendingCount() + this.calendars.pendingCount() + (this.config.hasPending() ? 1 : 0);
  }

  conflictCount() {
    return this.sessions.getConflicts().length + this.calendars.getConflicts().length;
  }

  ctx(): CalcContext {
    return { config: this.config.get(), calendars: this.calendars.calendars(), sessions: this.sessions.all(), now: nowUtc() };
  }

  today() {
    return madridDateOf(nowUtc());
  }

  tokenWarning(): string | null {
    if (!this.connection) return null;
    const s = tokenStatus(this.connection, this.today());
    if (s.kind === "caducado") return "El token de GitHub ha caducado. Crea uno nuevo y cámbialo en Ajustes.";
    if (s.kind === "caduca_pronto") return `El token de GitHub caduca en ${s.daysLeft} días. Renuévalo en Ajustes.`;
    return null;
  }

  async loadCarryover(course: CourseLabel): Promise<CarryoverFile | null> {
    if (!this.repo) return null;
    if (!(course in this.carryovers)) this.carryovers[course] = await readCarryover(this.repo, course).catch(() => null);
    return this.carryovers[course] ?? null;
  }
}
