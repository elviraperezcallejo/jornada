import { defaultConfig } from "../domain/defaults";
import { validateConfigFile } from "../domain/validate";
import type { ConfigFile } from "../domain/types";
import { GitHubClient, type RepoInfo } from "./github";
import { DataRepository } from "./repository";
import { PublicRepoError, StorageError } from "./errors";
import { CONFIG_PATH } from "./paths";
import type { ConnectionSettings } from "./credentials";

export interface ConnectionResult {
  repo: RepoInfo;
  config: ConfigFile;
  /** true si se acaba de crear config.json con los valores por defecto. */
  initialized: boolean;
}

/**
 * Comprueba la conexión antes de usarla:
 * 1. el token funciona y tiene acceso al repositorio;
 * 2. el repositorio es PRIVADO (si no, se rechaza para no publicar datos);
 * 3. se puede escribir (si GitHub lo indica);
 * 4. existe config.json; si no, se crea con los valores por defecto.
 */
export async function connect(
  settings: ConnectionSettings,
  fetchImpl?: typeof fetch,
): Promise<{ client: GitHubClient; repository: DataRepository; result: ConnectionResult }> {
  const client = new GitHubClient({ ...settings, fetchImpl });
  const repo = await client.getRepo();
  if (!repo.isPrivate) {
    throw new PublicRepoError(
      `El repositorio ${repo.fullName} es público. Usa un repositorio privado para los datos.`,
    );
  }
  if (repo.canPush === false) {
    throw new StorageError("El token no tiene permiso de escritura en el repositorio (Contents: Read and write).");
  }
  const repository = new DataRepository(client);
  const existing = await repository.read<ConfigFile>(CONFIG_PATH, validateConfigFile);
  if (existing) {
    return { client, repository, result: { repo, config: existing.data, initialized: false } };
  }
  const created = await repository.update<ConfigFile>(
    CONFIG_PATH,
    validateConfigFile,
    (cur) => cur ?? defaultConfig(),
    "Inicializar configuración",
  );
  return { client, repository, result: { repo, config: created.data, initialized: true } };
}
