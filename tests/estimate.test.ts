import { easterSunday, estimateFrom, withEstimates } from "../src/domain/estimate";
import { applyCalendarOp, laborabilityChanges, affectedWeeks, planAddEntries, planAddLeaveDays, planConfirm } from "../src/domain/calendar";
import { annualSummary, weekSummary } from "../src/domain/compute";
import { defaultConfig, emptyCalendar, seedCalendar2026_27 } from "../src/domain/defaults";
import { validateCalendarFile } from "../src/domain/validate";
import type { CalendarFile } from "../src/domain/types";

const T = "2026-10-16T10:00:00.000Z";
// En las pruebas se registra desde el inicio del curso, salvo que se indique lo contrario.
const config = { ...defaultConfig(T), trackingStartsOn: "2026-09-01" };

function confirmed(): CalendarFile {
  const cal = seedCalendar2026_27(T);
  const p = planConfirm(cal, "2026-27", cal.entries.filter((e) => e.category !== "academico").map((entry) => ({ entry, isWorkingDay: false })), T);
  if (!p.ok) throw new Error(p.errors.join());
  return applyCalendarOp(cal, p.op);
}

describe("Pascua", () => {
  it("calcula el Domingo de Resurrección", () => {
    expect(easterSunday(2026)).toBe("2026-04-05");
    expect(easterSunday(2027)).toBe("2027-03-28");
    expect(easterSunday(2028)).toBe("2028-04-16");
  });
});

describe("estimación del curso 2027-28 a partir del 2026-27", () => {
  const est = estimateFrom(confirmed(), "2027-28");
  const on = (name: string) => est.filter((e) => e.name === name).map((e) => e.date);

  it("festivos de fecha fija: mismo día y mes", () => {
    expect(on("Fiesta Nacional de España")).toEqual(["2027-10-12"]);
    expect(on("Inmaculada Concepción")).toEqual(["2027-12-08"]);
    expect(on("Virgen de San Lorenzo")).toEqual(["2027-09-08"]);
  });

  it("festivos trasladados al lunes: vuelven a su fecha original del año siguiente", () => {
    expect(on("Todos los Santos")).toEqual(["2027-11-01"]); // 02/11/2026 (lunes) → 01/11/2027 (lunes)
    expect(on("Día de la Constitución")).toEqual(["2027-12-06"]);
  });

  it("no lectivos y fiesta de centro: mismo día de la semana", () => {
    const nonLectivo = est.filter((e) => e.category === "uva_no_lectivo").map((e) => e.date);
    expect(nonLectivo).toContain("2027-10-29"); // viernes, como el 30/10/2026
    expect(on("San Alberto")).toEqual(["2027-11-12"]); // viernes, como el 13/11/2026
  });

  it("Semana Santa sigue a la Pascua; Navidad mantiene sus fechas", () => {
    const ss = on("Semana Santa");
    expect(ss[0]).toBe("2028-04-08");
    expect(ss.at(-1)).toBe("2028-04-18");
    const nav = on("Vacaciones de Navidad");
    expect([nav[0], nav.at(-1), nav.length]).toEqual(["2027-12-24", "2028-01-10", 18]);
  });

  it("conserva tus decisiones de «laboral sí/no» y marca el origen como estimado", () => {
    const e = est.find((x) => x.name === "Fiesta Nacional de España")!;
    expect(e).toMatchObject({ isWorkingDay: false, status: "confirmada" });
    expect(e.origin).toBe("Estimado a partir del curso 2026-27");
  });

  it("no copia vacaciones ni permisos personales", () => {
    const p = planAddLeaveDays(confirmed(), "2026-27", ["2026-11-20"], "permiso_personal", T);
    expect(p.ok && estimateFrom(applyCalendarOp(confirmed(), p.op), "2027-28").some((e) => e.category === "permiso_personal")).toBe(false);
  });

  it("un calendario estimado nunca se puede guardar", () => {
    const cals = withEstimates({ "2026-27": confirmed() }, ["2027-28"]);
    expect(validateCalendarFile(cals["2027-28"]).join()).toMatch(/estimado no se puede guardar/);
  });
});

describe("cálculos con calendario estimado", () => {
  const sessions = ["13", "14", "15"].map((d) => ({
    id: d, updatedAt: T, origin: "boton" as const,
    start: new Date(`2027-10-${d}T08:00+02:00`).toISOString(), end: new Date(`2027-10-${d}T15:30+02:00`).toISOString(),
  }));

  it("la semana del 12/10/2027 tiene 30 h de referencia y se marca como estimada", () => {
    const s = weekSummary("2027-10-12", { config, calendars: { "2026-27": confirmed() }, sessions, now: "2027-10-20T10:00:00.000Z" });
    expect(s.referenceHours).toBe(30);
    expect(s.estimatedCourses).toEqual(["2027-28"]);
  });

  it("si ya has puesto vacaciones en el curso nuevo, se mantienen y se añade la estimación", () => {
    const p = planAddLeaveDays(null, "2027-28", ["2027-10-15"], "vacaciones_contrato", T);
    if (!p.ok) throw new Error(p.errors.join());
    const s = weekSummary("2027-10-12", {
      config, calendars: { "2026-27": confirmed(), "2027-28": applyCalendarOp(null, p.op) }, sessions, now: "2027-10-20T10:00:00.000Z",
    });
    expect(s.referenceHours).toBe(22.5); // festivo estimado + vacaciones propias
    expect(s.estimatedCourses).toEqual(["2027-28"]);
  });

  it("en cuanto el curso tiene fechas oficiales propias, deja de estimar", () => {
    const p = planAddEntries(emptyCalendar("2027-28"), "2027-28", { from: "2027-10-12", category: "nacional_regional", isWorkingDay: false }, T);
    if (!p.ok) throw new Error(p.errors.join());
    const s = annualSummary("2027-28", {
      config, calendars: { "2026-27": confirmed(), "2027-28": applyCalendarOp(emptyCalendar("2027-28"), p.op) }, sessions: [], now: T,
    });
    expect(s.estimatedCourses).toEqual([]);
  });

  it("al importar el calendario real, el aviso compara con la estimación", () => {
    // Real: Todos los Santos el 01/11/2027 igual que la estimación, pero sin el 29/10.
    const real = planAddEntries(emptyCalendar("2027-28"), "2027-28", { from: "2027-11-01", category: "nacional_regional", isWorkingDay: false }, T);
    if (!real.ok) throw new Error(real.errors.join());
    const before = { "2026-27": confirmed() };
    const after = { ...before, "2027-28": applyCalendarOp(emptyCalendar("2027-28"), real.op) };
    const changes = laborabilityChanges(config, before, after, ["2027-10-29", "2027-11-01"]);
    expect(changes).toEqual([{ date: "2027-10-29", before: false, after: true }]);
    expect(affectedWeeks(changes)).toEqual(["2027-10-25"]);
  });
});
