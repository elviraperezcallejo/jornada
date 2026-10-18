import { DateTime } from "luxon";
import { isCivilDate } from "../domain/time";
import { TIMEZONE, type CivilDate } from "../domain/types";

/**
 * Datos de conexión al repositorio privado. Se guardan SOLO en el navegador
 * de cada dispositivo (localStorage), nunca en el código ni en el repositorio
 * público de la aplicación.
 */
export interface ConnectionSettings {
  owner: string;
  repo: string;
  token: string;
  /** Fecha de caducidad del token, la que eliges al crearlo en GitHub. */
  tokenExpiresOn: CivilDate | null;
}

/** Subconjunto de la API Storage del navegador (inyectable para pruebas). */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const KEY = "jornada.connection.v1";

export function loadConnection(store: KeyValueStore): ConnectionSettings | null {
  const raw = store.getItem(KEY);
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Partial<ConnectionSettings>;
    if (typeof c.owner !== "string" || typeof c.repo !== "string" || typeof c.token !== "string") return null;
    return {
      owner: c.owner,
      repo: c.repo,
      token: c.token,
      tokenExpiresOn: isCivilDate(c.tokenExpiresOn) ? c.tokenExpiresOn : null,
    };
  } catch {
    return null;
  }
}

export function saveConnection(store: KeyValueStore, c: ConnectionSettings): void {
  store.setItem(KEY, JSON.stringify(c));
}

/** "Cerrar sesión" en este dispositivo: borra el token local. */
export function clearConnection(store: KeyValueStore): void {
  store.removeItem(KEY);
}

export type TokenStatus =
  | { kind: "sin_fecha" }
  | { kind: "vigente"; daysLeft: number }
  | { kind: "caduca_pronto"; daysLeft: number }
  | { kind: "caducado" };

/** Aviso de caducidad. Por defecto avisa con 14 días de antelación (configurable). */
export function tokenStatus(c: ConnectionSettings, today: CivilDate, warnDays = 14): TokenStatus {
  if (!c.tokenExpiresOn) return { kind: "sin_fecha" };
  const t = DateTime.fromISO(today, { zone: TIMEZONE });
  const e = DateTime.fromISO(c.tokenExpiresOn, { zone: TIMEZONE });
  const daysLeft = Math.round(e.diff(t, "days").days);
  if (daysLeft < 0) return { kind: "caducado" };
  if (daysLeft <= warnDays) return { kind: "caduca_pronto", daysLeft };
  return { kind: "vigente", daysLeft };
}
