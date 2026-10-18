import { readFileSync } from "node:fs";
import { CalendarStore } from "../src/storage/calendarStore";
import { MemoryStore } from "../src/storage/local";
import { GitHubClient } from "../src/storage/github";
import { DataRepository } from "../src/storage/repository";
import { buildDraft } from "../src/import/importFlow";
import { planAddLeaveDays, planConfirm, planEditEntry, leaveCandidateDays } from "../src/domain/calendar";
import { defaultConfig } from "../src/domain/defaults";
import type { CalendarFile } from "../src/domain/types";
import { FakeGitHub } from "./fakeGitHub";

const TEXT = readFileSync(new URL("./fixtures/uva-2026-27-extracto.txt", import.meta.url), "utf8");
const T = "2026-10-16T10:00:00.000Z";
const config = defaultConfig(T);

function device(gh: FakeGitHub, local = new MemoryStore()) {
  const repo = new DataRepository(new GitHubClient({ owner: "yo", repo: "datos", token: "tok", fetchImpl: gh.fetch }));
  return new CalendarStore(local, repo, () => T);
}
const remote = (gh: FakeGitHub, course = "2026-27") =>
  JSON.parse(gh.files.get(`cursos/${course}/calendario.json`)?.text ?? "null") as CalendarFile | null;
const commits = (gh: FakeGitHub) => gh.requests.filter((r) => r.method === "PUT").length;

describe("importar y confirmar", () => {
  it("la propuesta se queda en el dispositivo; solo se guarda lo confirmado, en un único commit", async () => {
    const gh = new FakeGitHub();
    const store = device(gh);
    await store.init();
    const d = buildDraft(TEXT, "Calendario-26-27.pdf", config, T);
    if (!d.ok) throw new Error(d.message);
    await store.saveDraft(d.draft);
    expect(remote(gh)).toBeNull(); // nada en GitHub todavía
    expect((await store.loadDraft())?.entries).toHaveLength(d.draft.entries.length);

    // El usuario confirma los festivos nacionales como no laborables.
    const chosen = d.draft.entries.filter((e) => e.category === "nacional_regional");
    const plan = planConfirm(null, "2026-27", chosen.map((entry) => ({ entry, isWorkingDay: false })), T, "Importar calendario", "Calendario-26-27.pdf");
    const preview = store.preview(plan, config);
    expect(preview?.weeks).toContain("2026-10-12");
    expect(preview?.weeks).not.toContain("2027-04-26"); // el 01/05/2027 es sábado: no cambia nada

    const r = await store.apply(plan);
    expect(r.ok && r.sync.kind).toBe("sincronizado");
    await store.clearDraft();
    expect(commits(gh)).toBe(1);
    expect(remote(gh)?.entries).toHaveLength(6);
    expect(remote(gh)?.sourceName).toBe("Calendario-26-27.pdf");
    expect(remote(gh)?.entries.every((e) => e.status === "confirmada" && e.isWorkingDay === false)).toBe(true);
  });
});

describe("cursos independientes", () => {
  it("cada curso tiene su propio fichero y no se reutilizan fechas", async () => {
    const gh = new FakeGitHub();
    const store = device(gh);
    await store.init();
    const vac26 = planAddLeaveDays(null, "2026-27", ["2026-11-20"], "permiso_personal", T);
    await store.apply(vac26);
    const vac27 = planAddLeaveDays(null, "2027-28", ["2027-11-19"], "permiso_personal", T);
    await store.apply(vac27);
    expect(remote(gh, "2026-27")?.entries.map((e) => e.date)).toEqual(["2026-11-20"]);
    expect(remote(gh, "2027-28")?.entries.map((e) => e.date)).toEqual(["2027-11-19"]);

    const other = device(gh);
    await other.init();
    await other.pull();
    expect(Object.keys(other.calendars()).sort()).toEqual(["2026-27", "2027-28"]);
  });
});

describe("vacaciones de agosto", () => {
  it("propone los 22 laborables de agosto de 2027 y los guarda en un commit", async () => {
    const gh = new FakeGitHub();
    const store = device(gh);
    await store.init();
    const days = leaveCandidateDays("2027-08-01", "2027-08-31", config, store.calendars());
    expect(days).toHaveLength(22);
    await store.apply(planAddLeaveDays(store.calendar("2026-27"), "2026-27", days, "vacaciones_contrato", T, "Vacaciones de verano"));
    expect(commits(gh)).toBe(1);
    expect(remote(gh)?.entries).toHaveLength(22);
  });
});

describe("sin conexión y dos dispositivos", () => {
  it("guarda en el dispositivo y envía al volver la conexión", async () => {
    const gh = new FakeGitHub();
    const store = device(gh);
    await store.init();
    gh.offline = true;
    const r = await store.apply(planAddLeaveDays(null, "2026-27", ["2026-11-20"], "permiso_personal", T));
    expect(r.ok && r.sync.kind).toBe("pendiente");
    expect(store.calendar("2026-27")?.entries).toHaveLength(1);
    gh.offline = false;
    expect(await store.flush()).toEqual({ kind: "sincronizado" });
    expect(remote(gh)?.entries).toHaveLength(1);
  });

  it("si otro dispositivo cambió la misma fecha, el segundo cambio queda en conflicto", async () => {
    const gh = new FakeGitHub();
    const a = device(gh);
    await a.init();
    await a.apply(planAddLeaveDays(null, "2026-27", ["2026-11-20"], "permiso_personal", T));
    const b = device(gh);
    await b.init();
    await b.pull();
    const id = remote(gh)!.entries[0]!.id;

    gh.offline = true;
    await b.apply(planEditEntry(b.calendar("2026-27")!, id, { name: "Médico" }, "2026-10-16T11:00:00.000Z"));
    gh.offline = false;
    await a.apply(planEditEntry(a.calendar("2026-27")!, id, { name: "Gestiones" }, "2026-10-16T10:30:00.000Z"));
    await b.flush();
    expect(remote(gh)!.entries[0]!.name).toBe("Gestiones");
    expect(b.getConflicts()[0]?.reason).toMatch(/otro dispositivo/);
  });
});
