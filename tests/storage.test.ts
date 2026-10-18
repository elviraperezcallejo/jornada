import { utf8ToBase64, base64ToUtf8 } from "../src/storage/base64";
import { GitHubClient } from "../src/storage/github";
import { DataRepository } from "../src/storage/repository";
import { connect } from "../src/storage/connection";
import { AuthError, ConflictError, InvalidDataError, PublicRepoError, StorageError } from "../src/storage/errors";
import { sessionsPath, CONFIG_PATH } from "../src/storage/paths";
import { tokenStatus, loadConnection, saveConnection, clearConnection, type KeyValueStore } from "../src/storage/credentials";
import { validateSessionsFile } from "../src/domain/validate";
import { SCHEMA_VERSION, type SessionsFile } from "../src/domain/types";
import { FakeGitHub } from "./fakeGitHub";

const T = "2026-10-16T10:00:00.000Z";
const settings = { owner: "yo", repo: "datos-jornada", token: "tok", tokenExpiresOn: null };

function setup() {
  const gh = new FakeGitHub();
  const client = new GitHubClient({ ...settings, fetchImpl: gh.fetch });
  return { gh, client, repo: new DataRepository(client) };
}

const emptyMonth = (): SessionsFile => ({ schemaVersion: SCHEMA_VERSION, month: "2026-10", sessions: [] });
const addSession = (id: string, start: string) => (cur: SessionsFile | null): SessionsFile => {
  const f = cur ?? emptyMonth();
  const end = new Date(Date.parse(start) + 2 * 3600_000).toISOString(); // 2 h después
  f.sessions.push({ id, updatedAt: T, start, end, origin: "manual" });
  return f;
};

describe("Base64 con UTF-8", () => {
  it("conserva tildes y eñes, también con saltos de línea como los de GitHub", () => {
    const text = "Inmaculada Concepción · Año 2026 · ñ";
    const b64 = utf8ToBase64(text).replace(/(.{8})/g, "$1\n");
    expect(base64ToUtf8(b64)).toBe(text);
  });
});

describe("cliente de GitHub", () => {
  it("un fichero inexistente devuelve null", async () => {
    const { client } = setup();
    expect(await client.getFile("fichajes/2026-10.json")).toBeNull();
  });

  it("crea y luego actualiza con el sha correcto", async () => {
    const { client } = setup();
    const sha1 = await client.putFile("a.json", "{}", null, "crear");
    const sha2 = await client.putFile("a.json", '{"x":1}', sha1, "actualizar");
    expect(sha2).not.toBe(sha1);
    expect((await client.getFile("a.json"))?.text).toBe('{"x":1}');
  });

  it("con un sha antiguo lanza ConflictError (otro dispositivo escribió antes)", async () => {
    const { client } = setup();
    const sha1 = await client.putFile("a.json", "{}", null, "crear");
    await client.putFile("a.json", "{}", sha1, "otro dispositivo");
    await expect(client.putFile("a.json", "{}", sha1, "yo")).rejects.toBeInstanceOf(ConflictError);
  });

  it("un token incorrecto lanza AuthError", async () => {
    const gh = new FakeGitHub();
    const client = new GitHubClient({ ...settings, token: "malo", fetchImpl: gh.fetch });
    await expect(client.getFile("a.json")).rejects.toBeInstanceOf(AuthError);
  });

  it("las escrituras se hacen de una en una, aunque se lancen a la vez", async () => {
    let active = 0;
    let maxActive = 0;
    const gh = new FakeGitHub();
    const slowFetch: typeof fetch = async (i, init) => {
      if (init?.method === "PUT") {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }
      return gh.fetch(i, init);
    };
    const client = new GitHubClient({ ...settings, fetchImpl: slowFetch });
    await Promise.all([
      client.putFile("a.json", "1", null, "a"),
      client.putFile("b.json", "2", null, "b"),
      client.putFile("c.json", "3", null, "c"),
    ]);
    expect(maxActive).toBe(1);
  });

  it("rechaza nombres de usuario o repositorio con caracteres raros", () => {
    expect(() => new GitHubClient({ ...settings, repo: "../otro" })).toThrow();
  });
});

describe("repositorio de datos", () => {
  it("si otro dispositivo escribe entre medias, relee y aplica el cambio sobre lo nuevo", async () => {
    const { gh, repo } = setup();
    const path = sessionsPath("2026-10");
    await repo.update(path, validateSessionsFile, addSession("movil", "2026-10-16T06:00:00.000Z"), "móvil");
    // Simula que el ordenador guarda otro fichaje justo antes de nuestro PUT.
    gh.beforeNextPut = () => {
      const f = JSON.parse(gh.files.get(path)!.text) as SessionsFile;
      f.sessions.push({ id: "pc", updatedAt: T, start: "2026-10-15T06:00:00.000Z", end: "2026-10-15T08:00:00.000Z", origin: "manual" });
      gh.setFile(path, JSON.stringify(f));
    };
    await repo.update(path, validateSessionsFile, addSession("movil2", "2026-10-14T06:00:00.000Z"), "móvil 2");
    const ids = (JSON.parse(gh.files.get(path)!.text) as SessionsFile).sessions.map((s) => s.id).sort();
    expect(ids).toEqual(["movil", "movil2", "pc"]); // no se ha perdido nada
  });

  it("no escribe datos que no pasan la validación", async () => {
    const { gh, repo } = setup();
    const bad = () => ({ ...emptyMonth(), sessions: [{ id: "x", updatedAt: T, start: "mal", end: null, origin: "boton" }] });
    await expect(repo.update(sessionsPath("2026-10"), validateSessionsFile, bad as never, "x")).rejects.toBeInstanceOf(InvalidDataError);
    expect(gh.files.size).toBe(0);
  });

  it("se niega a usar un fichero remoto corrupto", async () => {
    const { gh, repo } = setup();
    gh.setFile(sessionsPath("2026-10"), "{ no es json");
    await expect(repo.read(sessionsPath("2026-10"), validateSessionsFile)).rejects.toBeInstanceOf(InvalidDataError);
  });

  it("si el conflicto persiste, se rinde con un error claro en vez de pisar datos", async () => {
    const { gh, client } = setup();
    const repo = new DataRepository(client, 2);
    const path = sessionsPath("2026-10");
    await repo.update(path, validateSessionsFile, addSession("a", "2026-10-16T06:00:00.000Z"), "a");
    const interfere = () => {
      gh.setFile(path, gh.files.get(path)!.text);
      gh.beforeNextPut = interfere;
    };
    gh.beforeNextPut = interfere;
    await expect(repo.update(path, validateSessionsFile, addSession("b", "2026-10-13T06:00:00.000Z"), "b")).rejects.toThrow(/tras 2 intentos/);
    gh.beforeNextPut = null;
  });
});

describe("conexión", () => {
  it("rechaza un repositorio de datos público", async () => {
    const gh = new FakeGitHub();
    gh.isPrivate = false;
    await expect(connect(settings, gh.fetch)).rejects.toBeInstanceOf(PublicRepoError);
  });

  it("rechaza un token sin permiso de escritura", async () => {
    const gh = new FakeGitHub();
    gh.canPush = false;
    await expect(connect(settings, gh.fetch)).rejects.toThrow(/permiso de escritura/);
  });

  it("en un repositorio vacío crea config.json con los valores por defecto", async () => {
    const gh = new FakeGitHub();
    const { result } = await connect(settings, gh.fetch);
    expect(result.initialized).toBe(true);
    expect(gh.files.has(CONFIG_PATH)).toBe(true);
    const again = await connect(settings, gh.fetch);
    expect(again.result.initialized).toBe(false);
  });

  it("un repositorio inexistente o sin acceso da un error comprensible", async () => {
    const gh = new FakeGitHub();
    const fetch404: typeof fetch = async () => new Response("{}", { status: 404 });
    await expect(connect(settings, fetch404)).rejects.toBeInstanceOf(StorageError);
    void gh;
  });
});

describe("credenciales locales", () => {
  const memory = (): KeyValueStore => {
    const m = new Map<string, string>();
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
  };

  it("guarda, carga y borra la conexión", () => {
    const store = memory();
    saveConnection(store, { ...settings, tokenExpiresOn: "2027-01-15" });
    expect(loadConnection(store)?.tokenExpiresOn).toBe("2027-01-15");
    clearConnection(store);
    expect(loadConnection(store)).toBeNull();
  });

  it("avisa de la caducidad del token", () => {
    const c = { ...settings, tokenExpiresOn: "2026-10-26" };
    expect(tokenStatus(c, "2026-10-01")).toEqual({ kind: "vigente", daysLeft: 25 });
    expect(tokenStatus(c, "2026-10-16")).toEqual({ kind: "caduca_pronto", daysLeft: 10 });
    expect(tokenStatus(c, "2026-10-27")).toEqual({ kind: "caducado" });
    expect(tokenStatus(settings, "2026-10-16")).toEqual({ kind: "sin_fecha" });
  });
});

describe("traslado de saldo en GitHub", () => {
  it("se guarda en el curso que lo recibe y se puede leer", async () => {
    const { readCarryover, saveCarryover } = await import("../src/storage/carryover");
    const { repo, gh } = setup();
    const file = {
      schemaVersion: SCHEMA_VERSION, course: "2027-28", fromCourse: "2026-27",
      hours: 5, sourceBalanceAtTransfer: 8, createdAt: T, updatedAt: T,
    };
    await saveCarryover(repo, file);
    expect(gh.files.has("cursos/2027-28/traslado.json")).toBe(true);
    expect(await readCarryover(repo, "2027-28")).toEqual(file);
    expect(await readCarryover(repo, "2026-27")).toBeNull();
  });
});
