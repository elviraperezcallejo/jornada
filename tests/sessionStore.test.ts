import { SessionStore } from "../src/storage/sessionStore";
import { MemoryStore } from "../src/storage/local";
import { GitHubClient } from "../src/storage/github";
import { DataRepository } from "../src/storage/repository";
import type { SessionsFile } from "../src/domain/types";
import { FakeGitHub } from "./fakeGitHub";

const M = (madrid: string) => new Date(`${madrid}+02:00`).toISOString();

function device(gh: FakeGitHub, local = new MemoryStore()) {
  let t = M("2026-10-16T08:00:00");
  const repo = new DataRepository(new GitHubClient({ owner: "yo", repo: "datos", token: "tok", fetchImpl: gh.fetch }));
  const store = new SessionStore(local, repo, () => t);
  return { store, local, setNow: (madrid: string) => (t = M(madrid)) };
}

const remote = (gh: FakeGitHub, month = "2026-10") =>
  JSON.parse(gh.files.get(`fichajes/${month}.json`)?.text ?? "null") as SessionsFile | null;

describe("fichaje con conexión", () => {
  it("entrar y salir quedan guardados en GitHub", async () => {
    const gh = new FakeGitHub();
    const d = device(gh);
    await d.store.init();
    expect((await d.store.toggle()).ok).toBe(true);
    d.setNow("2026-10-16T14:00:00");
    const r = await d.store.toggle();
    expect(r.ok && r.sync.kind).toBe("sincronizado");
    expect(remote(gh)?.sessions).toEqual([
      expect.objectContaining({ start: M("2026-10-16T08:00:00"), end: M("2026-10-16T14:00:00"), origin: "boton" }),
    ]);
  });

  it("un fichaje que cruza medianoche se guarda en el fichero del mes de entrada", async () => {
    const gh = new FakeGitHub();
    const d = device(gh);
    await d.store.init();
    d.setNow("2026-09-30T22:00:00");
    await d.store.toggle();
    d.setNow("2026-10-01T00:30:00");
    expect(d.store.state().kind).toBe("pendiente_revision");
    await d.store.toggle({ resolution: "ahora" });
    expect(remote(gh, "2026-09")?.sessions[0]?.end).toBe(M("2026-10-01T00:30:00"));
    expect(remote(gh, "2026-10")).toBeNull();
  });
});

describe("sin conexión", () => {
  it("el botón funciona, se ve el estado y se envía al volver la conexión", async () => {
    const gh = new FakeGitHub();
    const d = device(gh);
    await d.store.init();
    gh.offline = true;
    const r = await d.store.toggle({ offline: true });
    expect(r.ok && r.sync).toEqual({ kind: "pendiente", pending: 1, reason: "sin_red" });
    expect(d.store.state().kind).toBe("fichado");

    // Se cierra la app y se vuelve a abrir: el cambio sigue en el dispositivo.
    const reopened = device(gh, d.local);
    await reopened.store.init();
    expect(reopened.store.state().kind).toBe("fichado");
    expect(reopened.store.pendingCount()).toBe(1);

    gh.offline = false;
    expect(await reopened.store.flush()).toEqual({ kind: "sincronizado" });
    expect(remote(gh)?.sessions[0]).toMatchObject({ end: null, origin: "offline" });
  });

  it("reenviar un cambio que ya llegó (p. ej. tras un corte) no lo duplica", async () => {
    const gh = new FakeGitHub();
    const d = device(gh);
    await d.store.init();
    gh.offline = true;
    await d.store.toggle();
    const queueBefore = await d.local.get("sessions.queue.v1");
    gh.offline = false;
    await d.store.flush();
    await d.local.set("sessions.queue.v1", queueBefore); // como si no se hubiera llegado a vaciar la cola
    const again = device(gh, d.local);
    await again.store.init();
    expect(await again.store.flush()).toEqual({ kind: "sincronizado" });
    expect(remote(gh)?.sessions).toHaveLength(1);
    expect(again.store.getConflicts()).toEqual([]);
  });
});

describe("dos dispositivos", () => {
  it("si el ordenador ya fichó la entrada, la entrada offline del móvil queda en conflicto", async () => {
    const gh = new FakeGitHub();
    const pc = device(gh);
    const movil = device(gh);
    await pc.store.init();
    await movil.store.init();
    gh.offline = true;
    movil.setNow("2026-10-16T08:05:00");
    await movil.store.toggle({ offline: true });
    gh.offline = false;
    await pc.store.toggle(); // 08:00, llega antes a GitHub
    const s = await movil.store.flush();
    expect(s).toEqual({ kind: "sincronizado" });
    expect(remote(gh)?.sessions).toHaveLength(1); // no se ha creado una segunda entrada abierta
    const [c] = movil.store.getConflicts();
    expect(c?.reason).toMatch(/más de un fichaje abierto/);
    expect(movil.store.state().kind).toBe("fichado"); // ve la entrada del ordenador
  });

  it("si los dos cierran el mismo fichaje, gana el primero y el otro queda para revisar", async () => {
    const gh = new FakeGitHub();
    const pc = device(gh);
    const movil = device(gh);
    await pc.store.init();
    await pc.store.toggle(); // entrada 08:00
    await movil.store.init();
    await movil.store.flush(); // el móvil descarga la entrada abierta
    gh.offline = true;
    movil.setNow("2026-10-16T14:05:00");
    await movil.store.toggle({ offline: true });
    gh.offline = false;
    pc.setNow("2026-10-16T14:00:00");
    await pc.store.toggle();
    await movil.store.flush();
    expect(remote(gh)?.sessions[0]?.end).toBe(M("2026-10-16T14:00:00"));
    const [c] = movil.store.getConflicts();
    expect(c?.reason).toMatch(/otro dispositivo/);
    expect(c?.remote?.end).toBe(M("2026-10-16T14:00:00"));
    expect(c?.op.session.end).toBe(M("2026-10-16T14:05:00"));
    await movil.store.dismissConflict(c!.op.opId);
    expect(movil.store.getConflicts()).toEqual([]);
  });
});

describe("errores y eficiencia", () => {
  it("con un token inválido avisa y conserva los cambios pendientes", async () => {
    const gh = new FakeGitHub();
    gh.token = "otro";
    const d = device(gh);
    await d.store.init();
    const r = await d.store.toggle();
    expect(r.ok && r.sync.kind).toBe("credenciales");
    expect(d.store.pendingCount()).toBe(1);
  });

  it("solo descarga los meses que han cambiado", async () => {
    const gh = new FakeGitHub();
    const d = device(gh);
    await d.store.init();
    d.setNow("2026-09-15T08:00:00");
    await d.store.add({ start: M("2026-09-14T08:00:00"), end: M("2026-09-14T14:00:00") });
    await d.store.add({ start: M("2026-09-10T08:00:00"), end: M("2026-09-10T14:00:00") });
    d.setNow("2026-10-16T08:00:00");
    await d.store.toggle();
    gh.requests = [];
    await d.store.pull();
    const contentGets = gh.requests.filter((r) => r.method === "GET" && r.path.endsWith(".json"));
    expect(contentGets).toHaveLength(0); // nada cambió: solo se lista la carpeta
  });

  it("corregir y eliminar desde el historial", async () => {
    const gh = new FakeGitHub();
    const d = device(gh);
    await d.store.init();
    d.setNow("2026-10-16T12:00:00");
    await d.store.add({ start: M("2026-10-15T08:00:00"), end: M("2026-10-15T14:00:00") });
    const id = d.store.liveSessions()[0]!.id;
    await d.store.edit(id, { start: M("2026-10-15T08:30:00"), end: M("2026-10-15T14:00:00"), note: "llegué tarde" });
    expect(remote(gh)?.sessions[0]).toMatchObject({ start: M("2026-10-15T08:30:00"), note: "llegué tarde" });
    await d.store.remove(id);
    expect(d.store.liveSessions()).toEqual([]);
    expect(remote(gh)?.sessions[0]?.deleted).toBe(true);
  });
});
