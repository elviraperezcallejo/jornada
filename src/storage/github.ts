import { base64ToUtf8, utf8ToBase64 } from "./base64";
import { AuthError, ConflictError, ForbiddenError, NetworkError, StorageError } from "./errors";

/**
 * Cliente mínimo de la API REST de contenidos de GitHub.
 * Documentación: https://docs.github.com/en/rest/repos/contents
 *
 * - Leer:   GET  /repos/{owner}/{repo}/contents/{path}  → content (Base64) + sha
 * - Escribir: PUT /repos/{owner}/{repo}/contents/{path} con message, content
 *   y, si el fichero existe, el sha de la versión que se reemplaza.
 * - GitHub advierte de que PUT y DELETE en paralelo entran en conflicto, así
 *   que todas las escrituras pasan por una cola y se hacen de una en una.
 */

const API = "https://api.github.com";
/** Versión de la API indicada como la más reciente en la documentación (16/10/2026). */
export const GITHUB_API_VERSION = "2026-03-10";

export interface RemoteFile {
  text: string;
  sha: string;
}

export interface RepoInfo {
  fullName: string;
  isPrivate: boolean;
  /** Puede faltar según el tipo de token; null = desconocido. */
  canPush: boolean | null;
}

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  /** Inyectable para pruebas. */
  fetchImpl?: typeof fetch;
}

export class GitHubClient {
  private readonly fetchImpl: typeof fetch;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: GitHubClientOptions) {
    if (!/^[A-Za-z0-9-]+$/.test(opts.owner)) throw new Error("Usuario de GitHub no válido.");
    if (!/^[A-Za-z0-9._-]+$/.test(opts.repo)) throw new Error("Nombre de repositorio no válido.");
    if (!opts.token.trim()) throw new Error("Falta el token.");
    this.fetchImpl = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  private headers(): HeadersInit {
    return {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${this.opts.token}`,
      "X-GitHub-Api-Version": GITHUB_API_VERSION,
    };
  }

  private contentsUrl(path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${API}/repos/${this.opts.owner}/${this.opts.repo}/contents/${encoded}`;
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    try {
      // cache: "no-store" para no leer una versión antigua del fichero.
      return await this.fetchImpl(url, { ...init, cache: "no-store" });
    } catch (e) {
      throw new NetworkError(`No se pudo contactar con GitHub: ${(e as Error).message}`);
    }
  }

  private async fail(res: Response, action: string): Promise<never> {
    let detail = "";
    try {
      detail = ((await res.json()) as { message?: string }).message ?? "";
    } catch {
      /* cuerpo vacío o no JSON */
    }
    const msg = `${action}: ${res.status}${detail ? ` (${detail})` : ""}`;
    if (res.status === 401) throw new AuthError(`${msg}. Revisa el token o si ha caducado.`, 401);
    if (res.status === 403) throw new ForbiddenError(`${msg}. Falta permiso o se alcanzó el límite de peticiones.`, 403);
    if (res.status === 409 || res.status === 422) throw new ConflictError(msg, res.status);
    throw new StorageError(msg, res.status);
  }

  /** Datos del repositorio: sirve para comprobar que es privado y escribible. */
  async getRepo(): Promise<RepoInfo> {
    const res = await this.request(`${API}/repos/${this.opts.owner}/${this.opts.repo}`, {
      method: "GET",
      headers: this.headers(),
    });
    if (res.status === 404) {
      throw new StorageError("Repositorio no encontrado, o el token no tiene acceso a él.", 404);
    }
    if (!res.ok) await this.fail(res, "Leer el repositorio");
    const body = (await res.json()) as {
      full_name: string;
      private: boolean;
      permissions?: { push?: boolean };
    };
    return {
      fullName: body.full_name,
      isPrivate: body.private === true,
      canPush: typeof body.permissions?.push === "boolean" ? body.permissions.push : null,
    };
  }

  /** Lee un fichero. Devuelve null si no existe. */
  async getFile(path: string): Promise<RemoteFile | null> {
    const res = await this.request(this.contentsUrl(path), { method: "GET", headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) await this.fail(res, `Leer ${path}`);
    const body = (await res.json()) as { type?: string; encoding?: string; content?: string; sha?: string };
    if (body.type !== "file" || typeof body.sha !== "string") {
      throw new StorageError(`${path} no es un fichero.`);
    }
    // Por encima de 1 MB la API no devuelve el contenido en Base64. Nuestros
    // ficheros (uno por mes) deberían ser mucho más pequeños.
    if (body.encoding !== "base64" || typeof body.content !== "string") {
      throw new StorageError(`${path} es demasiado grande o tiene una codificación inesperada.`);
    }
    return { text: base64ToUtf8(body.content), sha: body.sha };
  }

  /**
   * Lista una carpeta (nombre, ruta, sha y tipo de cada entrada). Carpeta
   * inexistente → lista vacía. La API devuelve como mucho 1.000 entradas por
   * carpeta: con un fichero por mes no es un límite práctico.
   */
  async listDir(path: string): Promise<{ name: string; path: string; sha: string; type: "file" | "dir" }[]> {
    const res = await this.request(this.contentsUrl(path), { method: "GET", headers: this.headers() });
    if (res.status === 404) return [];
    if (!res.ok) await this.fail(res, `Listar ${path}`);
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) throw new StorageError(`${path} no es una carpeta.`);
    return body
      .filter((e: { type?: string; sha?: unknown }) => (e.type === "file" || e.type === "dir") && typeof e.sha === "string")
      .map((e: { name: string; path: string; sha: string; type: "file" | "dir" }) => ({
        name: e.name, path: e.path, sha: e.sha, type: e.type,
      }));
  }

  /**
   * Crea (sha = null) o reemplaza (sha = versión leída) un fichero.
   * Devuelve el nuevo sha. Si otro dispositivo escribió antes → ConflictError.
   */
  putFile(path: string, text: string, sha: string | null, message: string): Promise<string> {
    const run = async () => {
      const body: Record<string, unknown> = { message, content: utf8ToBase64(text) };
      if (sha) body.sha = sha;
      const res = await this.request(this.contentsUrl(path), {
        method: "PUT",
        headers: { ...this.headers(), "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) await this.fail(res, `Guardar ${path}`);
      const out = (await res.json()) as { content?: { sha?: string } };
      if (typeof out.content?.sha !== "string") throw new StorageError(`Respuesta inesperada al guardar ${path}.`);
      return out.content.sha;
    };
    // Encadenar en la cola; un fallo no bloquea las escrituras siguientes.
    const next = this.writeQueue.then(run, run);
    this.writeQueue = next.catch(() => undefined);
    return next;
  }
}
