import { GitHubClient } from "./github";
import { ConflictError, InvalidDataError, StorageError } from "./errors";
import type { ValidationErrors } from "../domain/validate";

/**
 * Lectura/escritura validada de ficheros JSON del repositorio de datos.
 *
 * update() aplica una modificación sobre la versión más reciente del fichero.
 * Si otro dispositivo escribió entre medias (conflicto), vuelve a leer y
 * repite la modificación sobre los datos nuevos, en lugar de pisarlos.
 * Por eso las modificaciones se expresan como funciones ("añade el fichaje X",
 * "cierra el fichaje Y"), no como el fichero completo ya calculado.
 */

export interface Loaded<T> {
  data: T;
  sha: string;
}

export type Validator = (data: unknown) => ValidationErrors;

export class DataRepository {
  constructor(
    private readonly client: GitHubClient,
    private readonly maxRetries = 3,
  ) {}

  /** Lista los ficheros de una carpeta con su sha (para descargar solo lo que cambió). */
  listDir(path: string) {
    return this.client.listDir(path);
  }

  async read<T>(path: string, validate: Validator): Promise<Loaded<T> | null> {
    const file = await this.client.getFile(path);
    if (!file) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      throw new InvalidDataError(path, ["El fichero no es JSON válido."]);
    }
    const errs = validate(parsed);
    if (errs.length) throw new InvalidDataError(path, errs);
    return { data: parsed as T, sha: file.sha };
  }

  /**
   * @param mutate recibe los datos actuales (o null si el fichero no existe)
   *               y devuelve los nuevos. Debe ser una función pura: puede
   *               ejecutarse más de una vez si hay conflictos.
   */
  async update<T>(
    path: string,
    validate: Validator,
    mutate: (current: T | null) => T,
    message: string,
  ): Promise<Loaded<T>> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.read<T>(path, validate);
      const next = mutate(current ? structuredClone(current.data) : null);
      const errs = validate(next);
      if (errs.length) throw new InvalidDataError(path, errs);
      // Sin cambios reales: no se escribe (evita commits vacíos y hace
      // que reintentar una operación ya aplicada sea inofensivo).
      if (current && JSON.stringify(current.data) === JSON.stringify(next)) {
        return { data: current.data, sha: current.sha };
      }
      const text = JSON.stringify(next, null, 2) + "\n";
      try {
        const sha = await this.client.putFile(path, text, current?.sha ?? null, message);
        return { data: next, sha };
      } catch (e) {
        if (e instanceof ConflictError && attempt + 1 < this.maxRetries) continue;
        if (e instanceof ConflictError) {
          throw new StorageError(
            `No se pudo guardar ${path} tras ${this.maxRetries} intentos: otro dispositivo lo está modificando.`,
            e.status,
          );
        }
        throw e;
      }
    }
  }
}
