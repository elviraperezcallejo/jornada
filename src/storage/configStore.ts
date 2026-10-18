import { defaultConfig } from "../domain/defaults";
import { nowUtc } from "../domain/time";
import type { ConfigFile } from "../domain/types";
import { validateConfigFile } from "../domain/validate";
import { AuthError, ForbiddenError, NetworkError, StorageError } from "./errors";
import type { LocalStore } from "./local";
import { CONFIG_PATH } from "./paths";
import type { DataRepository } from "./repository";

/**
 * Ajustes (config.json). Se guardan primero en el dispositivo y se envían a
 * GitHub cuando hay conexión. Si al enviarlos resulta que se cambiaron desde
 * otro dispositivo, no se pisan: se avisa y se descarta el cambio local.
 */
interface Saved {
  config: ConfigFile;
  /** Cambio local aún no enviado. */
  pending: ConfigFile | null;
  /** updatedAt de la versión remota sobre la que se hizo el cambio. */
  base: string | null;
}

const KEY = "config.v1";

export type ConfigSync = { ok: true } | { ok: false; message: string; kind: "sin_red" | "conflicto" | "credenciales" | "error" };

export class ConfigStore {
  private s: Saved = { config: defaultConfig(), pending: null, base: null };
  private repo: DataRepository | null = null;

  constructor(private readonly local: LocalStore, private readonly now: () => string = nowUtc) {}

  async init() {
    this.s = (await this.local.get<Saved>(KEY)) ?? this.s;
  }

  setRepository(repo: DataRepository | null) {
    this.repo = repo;
  }

  get(): ConfigFile {
    return this.s.pending ?? this.s.config;
  }

  hasPending() {
    return this.s.pending !== null;
  }

  /** Versión recién leída de GitHub. */
  async setRemote(config: ConfigFile) {
    this.s.config = config;
    if (!this.s.pending) this.s.base = config.updatedAt;
    await this.local.set(KEY, this.s);
  }

  /** Cambia ajustes. Devuelve los errores de validación (vacío = guardado en el dispositivo). */
  async change(mutate: (c: ConfigFile) => ConfigFile): Promise<string[]> {
    const next = { ...mutate(structuredClone(this.get())), updatedAt: this.now() };
    const errs = validateConfigFile(next);
    if (errs.length) return errs;
    if (!this.s.pending) this.s.base = this.s.config.updatedAt;
    this.s.pending = next;
    await this.local.set(KEY, this.s);
    return [];
  }

  async flush(): Promise<ConfigSync> {
    if (!this.repo) return { ok: true };
    try {
      const remote = await this.repo.read<ConfigFile>(CONFIG_PATH, validateConfigFile);
      if (remote && !this.s.pending) {
        await this.setRemote(remote.data);
        return { ok: true };
      }
      if (!this.s.pending) return { ok: true };
      if (remote && remote.data.updatedAt !== this.s.base) {
        const message = "Los ajustes se cambiaron desde otro dispositivo. Se ha descartado el cambio hecho en este; revísalo de nuevo.";
        this.s.pending = null;
        await this.setRemote(remote.data);
        return { ok: false, kind: "conflicto", message };
      }
      const pending = this.s.pending;
      const saved = await this.repo.update<ConfigFile>(CONFIG_PATH, validateConfigFile, () => pending, "Actualizar ajustes");
      this.s.pending = null;
      await this.setRemote(saved.data);
      return { ok: true };
    } catch (e) {
      if (e instanceof NetworkError) return { ok: false, kind: "sin_red", message: e.message };
      if (e instanceof AuthError || e instanceof ForbiddenError) return { ok: false, kind: "credenciales", message: e.message };
      return { ok: false, kind: "error", message: e instanceof StorageError ? e.message : String(e) };
    }
  }
}
