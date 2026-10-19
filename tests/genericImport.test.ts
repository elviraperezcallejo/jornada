import { readFileSync } from "node:fs";
import { parseGenericCalendar, periodFromText } from "../src/import/parseGenericCalendar";
import { buildDraft, groupByCourse } from "../src/import/importFlow";
import { defaultConfig } from "../src/domain/defaults";
import { validateConfigFile } from "../src/domain/validate";
import { categoryLabel, GENERIC_TEMPLATE, periodLabel, profileOf } from "../src/domain/profile";

const T = "2026-10-16T10:00:00.000Z";
const UVA_TEXT = readFileSync(new URL("./fixtures/uva-2026-27-extracto.txt", import.meta.url), "utf8");
const rows = (items: { from: string; to?: string; category: string; name: string }[]) =>
  items.map((i) => [i.from, i.to ?? null, i.category, i.name]);

describe("lector genérico", () => {
  it("lee la plantilla de la app: año natural, categorías por encabezado y periodos", () => {
    const r = parseGenericCalendar(GENERIC_TEMPLATE);
    expect(r.period).toBe("2027");
    expect(r.warnings).toEqual([]);
    expect(rows(r.items)).toEqual([
      ["2027-01-01", null, "nacional_regional", "Año Nuevo"],
      ["2027-01-06", null, "nacional_regional", "Epifanía del Señor"],
      ["2027-05-01", null, "nacional_regional", "Fiesta del Trabajo"],
      ["2027-10-12", null, "nacional_regional", "Fiesta Nacional"],
      ["2027-05-15", null, "local", "Fiesta local"],
      ["2027-12-07", null, "uva_no_lectivo", "Puente"],
      ["2027-12-24", "2027-12-31", "periodo_vacacional", "Navidad"],
    ]);
  });

  it("entiende fechas numéricas, ISO, periodos y traslados, e ignora referencias a normas", () => {
    const r = parseGenericCalendar(`Decreto 9/2025, de 29 de mayo, por el que se establece el calendario
BOCYL de 2 de junio de 2025
12/10/2026 Fiesta Nacional de España
08/12 Inmaculada Concepción
2026-12-24 a 2027-01-06 Cierre de Navidad
- 2 de noviembre: Todos los Santos (traslado)`, { hint: "2026-27" });
    expect(rows(r.items)).toEqual([
      ["2026-10-12", null, "nacional_regional", "Fiesta Nacional de España"],
      ["2026-12-08", null, "nacional_regional", "Inmaculada Concepción"],
      ["2026-12-24", "2027-01-06", "periodo_vacacional", "Cierre de Navidad"],
      ["2026-11-02", null, "nacional_regional", "Todos los Santos"],
    ]);
    expect(r.items[3]!.isTransfer).toBe(true);
  });

  it("lee el texto de un PDF de empresa con fechas numéricas y periodos, sin la fecha de aprobación", () => {
    const r = parseGenericCalendar(`Empresa Ejemplo S.L.
Calendario laboral 2027
Aprobado el 15/11/2026 por la dirección
Festivos nacionales y autonómicos
01/01/2027 Año Nuevo
02/04/2027 Viernes Santo
Fiestas locales
15/05/2027 San Isidro
Cierres de la empresa
Del 2 al 13 de agosto de 2027: Cierre de verano
Del 24 al 31 de diciembre de 2027: Cierre de Navidad`);
    expect(rows(r.items)).toEqual([
      ["2027-01-01", null, "nacional_regional", "Año Nuevo"],
      ["2027-04-02", null, "nacional_regional", "Viernes Santo"],
      ["2027-05-15", null, "local", "San Isidro"],
      ["2027-08-02", "2027-08-13", "periodo_vacacional", "Cierre de verano"],
      ["2027-12-24", "2027-12-31", "periodo_vacacional", "Cierre de Navidad"],
    ]);
  });

  it("lee tablas «Mes Año · días · motivo» (también separadas por tabuladores)", () => {
    const table = `Mes\tFechas\tMotivo
Octubre 2026\tViernes 30\tDía no lectivo
Noviembre 2026\tLunes 2\tFiesta laboral
Diciembre 2026\tLunes 7 y martes 8\tFiestas laborales
Diciembre 2026\tDel miércoles 23 al jueves 31\tVacaciones escolares
Enero 2027\tDel viernes 1 al domingo 10\tVacaciones escolares
Febrero 2027\tLunes 8 y martes 9\tDías no lectivos
Marzo 2027\tDel sábado 20 al martes 30\tVacaciones escolares
Abril 2027\tViernes 23\tFiesta laboral
Mayo 2027\tSábado 1\tFiesta laboral`;
    const r = parseGenericCalendar(table);
    expect(r.warnings).toEqual([]); // todos los días de la semana coinciden con las fechas
    expect(rows(r.items)).toEqual([
      ["2026-10-30", null, "uva_no_lectivo", "Día no lectivo"],
      ["2026-11-02", null, "nacional_regional", "Fiesta laboral"],
      ["2026-12-07", null, "nacional_regional", "Fiestas laborales"],
      ["2026-12-08", null, "nacional_regional", "Fiestas laborales"],
      ["2026-12-23", "2026-12-31", "periodo_vacacional", "Vacaciones escolares"],
      ["2027-01-01", "2027-01-10", "periodo_vacacional", "Vacaciones escolares"],
      ["2027-02-08", null, "uva_no_lectivo", "Días no lectivos"],
      ["2027-02-09", null, "uva_no_lectivo", "Días no lectivos"],
      ["2027-03-20", "2027-03-30", "periodo_vacacional", "Vacaciones escolares"],
      ["2027-04-23", null, "nacional_regional", "Fiesta laboral"],
      ["2027-05-01", null, "nacional_regional", "Fiesta laboral"],
    ]);
  });

  it("avisa si el día de la semana no coincide con la fecha", () => {
    const r = parseGenericCalendar("Octubre 2026 Lunes 30 Día no lectivo");
    expect(r.items).toHaveLength(1);
    expect(r.warnings.join()).toMatch(/no coincide/);
  });

  it("sin año en el texto ni indicado, avisa en vez de inventarlo", () => {
    const r = parseGenericCalendar("12 de octubre: Fiesta Nacional");
    expect(r.items).toEqual([]);
    expect(r.warnings.join()).toMatch(/sin año/);
  });

  it("deduce el periodo de títulos habituales", () => {
    expect(periodFromText("Calendario laboral 2027")).toBe("2027");
    expect(periodFromText("Festivos 2026-2027")).toBe("2026-27");
    expect(periodFromText("Año 2028")).toBe("2028");
  });
});

describe("importación: la UVa no cambia y lo demás usa el lector genérico", () => {
  it("el PDF de la UVa sigue usando el lector de la UVa", () => {
    const d = buildDraft(UVA_TEXT, "Calendario-26-27.pdf", defaultConfig(T), T);
    expect(d.ok && d.draft.parser).toBe("uva");
    expect(d.ok && d.draft.items).toHaveLength(18);
  });

  it("la plantilla genérica de un año natural reparte las fechas en dos cursos", () => {
    const d = buildDraft(GENERIC_TEMPLATE, "plantilla", defaultConfig(T), T);
    expect(d.ok).toBe(true);
    if (!d.ok) return;
    expect(d.draft.parser).toBe("generico");
    expect(d.draft.label).toBe("2027");
    expect(d.draft.warnings[0]).toMatch(/no tiene el formato del calendario de la UVa/);
    const groups = groupByCourse(d.draft.entries);
    expect([...groups.keys()]).toEqual(["2026-27", "2027-28"]);
    expect(groups.get("2027-28")!.map((e) => e.date)).toContain("2027-10-12");
  });

  it("se puede indicar el año a mano para fechas sin año", () => {
    const d = buildDraft("Festivos:\n12 de octubre: Fiesta Nacional", "texto", defaultConfig(T), T, () => [], "2027");
    expect(d.ok && d.draft.entries.map((e) => e.date)).toEqual(["2027-10-12"]);
  });
});

describe("perfil", () => {
  it("sin perfil en config.json (ficheros antiguos) se trata como UVa y sigue siendo válido", () => {
    const c = defaultConfig(T);
    expect(c.profile).toBeUndefined();
    expect(validateConfigFile(c)).toEqual([]);
    expect(profileOf(c)).toBe("uva");
    expect(validateConfigFile({ ...c, profile: "generico" })).toEqual([]);
    expect(validateConfigFile({ ...c, profile: "otro" as never }).join()).toMatch(/profile/);
  });

  it("los textos cambian según el perfil", () => {
    expect(categoryLabel("uva_no_lectivo", "uva")).toBe("No lectivo en la UVa");
    expect(categoryLabel("uva_no_lectivo", "generico")).toBe("Cierre o día no laborable de la empresa");
    expect(periodLabel("2026-27", "uva")).toBe("curso 2026-27");
    expect(periodLabel("2026-27", "generico")).toBe("periodo de septiembre de 2026 a agosto de 2027");
  });
});

describe("estimación para otros trabajos (por año natural)", () => {
  it("con 2027 importado, enero–agosto de 2028 se estima aunque sep–dic de 2027 ya tenga fechas", async () => {
    const { planConfirm, applyCalendarOp } = await import("../src/domain/calendar");
    const { annualSummary } = await import("../src/domain/compute");
    const d = buildDraft(GENERIC_TEMPLATE, "plantilla", defaultConfig(T), T);
    if (!d.ok) throw new Error(d.message);
    const cals: Record<string, ReturnType<typeof applyCalendarOp>> = {};
    for (const [course, group] of groupByCourse(d.draft.entries)) {
      const p = planConfirm(null, course, group.map((entry) => ({ entry, isWorkingDay: false })), T);
      if (!p.ok) throw new Error(p.errors.join());
      cals[course] = applyCalendarOp(null, p.op);
    }
    const base = { ...defaultConfig(T), trackingStartsOn: "2027-01-01" };
    const generic = annualSummary("2028", { config: { ...base, profile: "generico" }, calendars: cals, sessions: [], now: "2028-12-31T12:00:00.000Z" });
    expect(generic.estimatedCourses).toEqual(["2027-28", "2028-29"]); // todo 2028 es estimado
    expect(generic.days.find((x) => x.date === "2028-10-12")?.info.isWorkday).toBe(false); // Fiesta Nacional estimada
    expect(generic.days.find((x) => x.date === "2028-01-06")?.info.isWorkday).toBe(false); // Epifanía estimada
    // Con el perfil UVa el comportamiento no cambia: el curso tiene fechas y no se estima.
    const uva = annualSummary("2028", { config: base, calendars: cals, sessions: [], now: "2028-12-31T12:00:00.000Z" });
    expect(uva.days.find((x) => x.date === "2028-01-06")?.info.isWorkday).toBe(true);
  });
});

describe("plantillas visibles en la app", () => {
  it("la plantilla de tabla se lee completa y sin avisos", async () => {
    const { TABLE_TEMPLATE } = await import("../src/domain/profile");
    const r = parseGenericCalendar(TABLE_TEMPLATE);
    expect(r.warnings).toEqual([]);
    expect(rows(r.items)).toEqual([
      ["2026-10-12", null, "nacional_regional", "Fiesta Nacional"],
      ["2026-12-07", null, "nacional_regional", "Fiestas laborales"],
      ["2026-12-08", null, "nacional_regional", "Fiestas laborales"],
      ["2026-12-24", "2026-12-31", "periodo_vacacional", "Cierre de Navidad"],
      ["2027-05-15", null, "local", "Fiesta local"],
    ]);
  });
});
