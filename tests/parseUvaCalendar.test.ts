import { readFileSync } from "node:fs";
import { parseUvaCalendar, proposalToEntries } from "../src/import/parseUvaCalendar";
import { buildDraft } from "../src/import/importFlow";
import { defaultConfig, seedCalendar2026_27 } from "../src/domain/defaults";

/** Texto extraído con pdf.js del PDF oficial (extracto: periodos de grado y días festivos). */
const TEXT = readFileSync(new URL("./fixtures/uva-2026-27-extracto.txt", import.meta.url), "utf8");
const T = "2026-10-16T10:00:00.000Z";
const VA = { campus: "Valladolid", centre: "Facultad de Ciencias" };

describe("lector del calendario académico UVa 2026-27", () => {
  const r = parseUvaCalendar(TEXT, VA);
  const rows = r.items.map((i) => [i.from, i.to ?? null, i.category, i.isTransfer, i.name]);

  it("detecta el curso y no deja avisos", () => {
    expect(r.course).toBe("2026-27");
    expect(r.warnings).toEqual([]);
  });

  it("extrae exactamente los festivos y días no lectivos del PDF", () => {
    expect(rows).toEqual([
      ["2026-10-12", null, "nacional_regional", false, "Fiesta Nacional de España"],
      ["2026-11-02", null, "nacional_regional", true, "Todos los Santos"],
      ["2026-12-07", null, "nacional_regional", true, "Día de la Constitución Española"],
      ["2026-12-08", null, "nacional_regional", false, "Inmaculada Concepción"],
      ["2027-04-23", null, "nacional_regional", false, "Día de Castilla y León"],
      ["2027-05-01", null, "nacional_regional", false, "Día de los Trabajadores"],
      ["2026-10-30", null, "uva_no_lectivo", false, "Día no lectivo"],
      ["2026-12-04", null, "uva_no_lectivo", false, "San Nicolás de Bari"],
      ["2027-01-29", null, "uva_no_lectivo", true, "Fiesta de Santo Tomás de Aquino"],
      ["2026-12-24", "2027-01-10", "periodo_vacacional", false, "Vacaciones de Navidad"],
      ["2027-03-20", "2027-03-30", "periodo_vacacional", false, "Semana Santa"],
      ["2027-05-13", null, "local", false, "San Pedro Regalado"],
      ["2026-09-08", null, "local", false, "Virgen de San Lorenzo"],
      ["2026-11-13", null, "centro", true, "San Alberto"],
      ["2026-09-07", null, "academico", false, "Inicio del periodo lectivo de grado (1.er cuatrimestre)"],
      ["2027-02-05", null, "academico", false, "Fin del periodo lectivo de grado, con exámenes (1.er cuatrimestre)"],
      ["2027-02-08", null, "academico", false, "Inicio del periodo lectivo de grado (2.º cuatrimestre)"],
      ["2027-06-25", null, "academico", false, "Fin del periodo lectivo de grado, con exámenes (2.º cuatrimestre)"],
    ]);
  });

  it("coincide con los datos semilla del enunciado en festivos, no lectivos y fiestas", () => {
    const seed = seedCalendar2026_27(T).entries.filter((e) => e.category !== "academico");
    const parsed = proposalToEntries(r.items, "PDF", T).filter((e) => e.category !== "academico");
    const key = (e: { date: string; category: string }) => `${e.date}|${e.category}`;
    expect(parsed.map(key).sort()).toEqual(seed.map(key).sort());
  });

  it("con otro campus y otro centro toma sus fechas y no confunde «Facultad de Ciencias» con otras", () => {
    const so = parseUvaCalendar(TEXT, { campus: "Soria", centre: "Facultad de Ciencias de la Salud de Soria" });
    const pick = so.items.filter((i) => i.category === "local" || i.category === "centro").map((i) => [i.from, i.name]);
    expect(pick).toEqual([
      ["2027-06-24", "La Saca"],
      ["2026-10-02", "San Saturio"],
      ["2027-03-08", "San Juan de Dios"],
    ]);
  });

  it("avisa si no encuentra el campus o el centro configurados", () => {
    const x = parseUvaCalendar(TEXT, { campus: "Burgos", centre: "Facultad Inventada" });
    expect(x.warnings.join(" ")).toMatch(/campus de Burgos/);
    expect(x.warnings.join(" ")).toMatch(/Facultad Inventada/);
  });
});

describe("texto pegado a mano", () => {
  it("acepta viñetas con guion, espacios de más y sin título si se indica el curso", () => {
    const pasted = `
      Festivos de ámbito nacional o regional:
      - 12 de octubre:   Fiesta Nacional de España.
      Días no lectivos para toda la Universidad de Valladolid:
      - Semana Santa: del 20 al 30 de marzo de 2027, ambos inclusive
      - 31 de febrero: fecha imposible
    `;
    const r = parseUvaCalendar(pasted, { ...VA, courseHint: "2026-27" });
    expect(r.items.map((i) => [i.from, i.to ?? null])).toEqual([
      ["2026-10-12", null],
      ["2027-03-20", "2027-03-30"],
    ]);
    expect(r.warnings.join(" ")).toMatch(/31 de febrero/);
  });

  it("si no reconoce nada no bloquea: propone pegar el texto o introducirlo a mano", () => {
    const d = buildDraft("Esto no es un calendario", "x.pdf", defaultConfig(T), T, () => [], "2026-27");
    expect(d.ok).toBe(false);
    expect(!d.ok && d.message).toMatch(/introducir las fechas a mano/);
  });

  it("sin curso en el texto ni indicado, lo pide", () => {
    const d = buildDraft("12 de octubre: algo", "x.pdf", defaultConfig(T), T);
    expect(!d.ok && d.message).toMatch(/a qué curso/);
  });
});

describe("propuesta → fechas para revisar", () => {
  it("expande los periodos día a día y no repite lo que ya existe", () => {
    const d = buildDraft(TEXT, "Calendario-26-27.pdf", defaultConfig(T), T);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.draft.course).toBe("2026-27");
    expect(d.draft.entries.filter((e) => e.name === "Vacaciones de Navidad")).toHaveLength(18);
    expect(d.draft.entries.filter((e) => e.name === "Semana Santa")).toHaveLength(11);
    expect(d.draft.entries.every((e) => e.status === "propuesta" && e.isWorkingDay === null)).toBe(true);
    expect(d.draft.entries[0]!.origin).toBe("PDF: Calendario-26-27.pdf");

    // Segunda importación del mismo PDF: nada nuevo.
    const again = buildDraft(TEXT, "Calendario-26-27.pdf", defaultConfig(T), T, () => d.draft.entries);
    expect(again.ok && again.draft.entries).toEqual([]);
    expect(again.ok && again.draft.warnings.join(" ")).toMatch(/ya estaban/);
  });
});
