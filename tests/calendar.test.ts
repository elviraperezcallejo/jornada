import {
  affectedWeeks,
  applyCalendarOp,
  dayInfo,
  laborabilityChanges,
  leaveCandidateDays,
  planAddEntries,
  planAddLeaveDays,
  planConfirm,
  planDeleteEntry,
  type Calendars,
} from "../src/domain/calendar";
import { defaultConfig, emptyCalendar, seedCalendar2026_27 } from "../src/domain/defaults";
import type { CalendarFile } from "../src/domain/types";

const T = "2026-10-16T10:00:00.000Z";
const config = defaultConfig(T);

function confirmedSeed(): CalendarFile {
  // Todas las fechas semilla salvo las académicas confirmadas como no laborables.
  const cal = seedCalendar2026_27(T);
  const decisions = cal.entries.filter((e) => e.category !== "academico").map((entry) => ({ entry, isWorkingDay: false }));
  const p = planConfirm(cal, "2026-27", decisions, T);
  if (!p.ok) throw new Error(p.errors.join());
  return applyCalendarOp(cal, p.op);
}

describe("laborabilidad de un día", () => {
  it("una fecha solo propuesta NO cambia nada, pero queda señalada como sin decidir", () => {
    const cals: Calendars = { "2026-27": seedCalendar2026_27(T) };
    const d = dayInfo("2026-10-12", config, cals);
    expect(d.isWorkday).toBe(true);
    expect(d.undecided).toHaveLength(1);
  });

  it("confirmada como no laborable, el 12/10/2026 (lunes) no lleva referencia", () => {
    const d = dayInfo("2026-10-12", config, { "2026-27": confirmedSeed() });
    expect(d.contractWorkday).toBe(true);
    expect(d.isWorkday).toBe(false);
    expect(d.nonWorking[0]!.name).toBe("Fiesta Nacional de España");
  });

  it("un sábado no es laborable por contrato", () => {
    expect(dayInfo("2026-10-17", config, { "2026-27": emptyCalendar("2026-27") }).isWorkday).toBe(false);
  });

  it("un día anterior al contrato no lleva referencia", () => {
    expect(dayInfo("2026-08-31", config, {}).term).toBeNull();
    expect(dayInfo("2026-08-31", config, {}).isWorkday).toBe(false);
  });

  it("avisa si no hay calendario cargado para ese curso", () => {
    expect(dayInfo("2027-10-04", config, { "2026-27": emptyCalendar("2026-27") }).missingCalendar).toBe(true);
  });
});

describe("vacaciones, permisos y compensación", () => {
  const base = emptyCalendar("2026-27");

  it("vacaciones en día laborable: sin referencia y gastan cupo", () => {
    const p = planAddLeaveDays(base, "2026-27", ["2026-11-20"], "permiso_personal", T);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const d = dayInfo("2026-11-20", config, { "2026-27": applyCalendarOp(base, p.op) });
    expect(d.isWorkday).toBe(false);
    expect(d.consumesLeave).toBe(true);
  });

  it("vacaciones en sábado o en festivo confirmado: no gastan cupo", () => {
    const sat = planAddLeaveDays(base, "2026-27", ["2026-11-21"], "vacaciones_contrato", T);
    expect(sat.ok && dayInfo("2026-11-21", config, { "2026-27": applyCalendarOp(base, sat.op) }).consumesLeave).toBe(false);
    const cal = confirmedSeed();
    const hol = planAddLeaveDays(cal, "2026-27", ["2026-10-12"], "vacaciones_contrato", T);
    expect(hol.ok && dayInfo("2026-10-12", config, { "2026-27": applyCalendarOp(cal, hol.op) }).consumesLeave).toBe(false);
  });

  it("un día de compensación mantiene la referencia (consume saldo de horas)", () => {
    const p = planAddEntries(base, "2026-27", { from: "2026-11-27", category: "compensacion" }, T);
    expect(p.ok && dayInfo("2026-11-27", config, { "2026-27": applyCalendarOp(base, p.op) }).isWorkday).toBe(true);
  });

  it("agosto de 2027 tiene 22 días que gastarían cupo; con un festivo entre semana, 21", () => {
    expect(leaveCandidateDays("2027-08-01", "2027-08-31", config, { "2026-27": base })).toHaveLength(22);
    const p = planAddEntries(base, "2026-27", { from: "2027-08-16", category: "otro", name: "Festivo de prueba", isWorkingDay: false }, T);
    expect(p.ok && leaveCandidateDays("2027-08-01", "2027-08-31", config, { "2026-27": applyCalendarOp(base, p.op) })).toHaveLength(21);
  });

  it("al añadir vacaciones se fuerzan como no laborables", () => {
    const p = planAddEntries(base, "2026-27", { from: "2027-08-02", category: "vacaciones_contrato", isWorkingDay: true }, T);
    expect(p.ok && p.op.entries[0]!.isWorkingDay).toBe(false);
  });
});

describe("edición del calendario", () => {
  it("un periodo que cruza de un curso a otro se rechaza (hay que dividirlo)", () => {
    const p = planAddEntries(emptyCalendar("2026-27"), "2026-27", { from: "2027-08-30", to: "2027-09-02", category: "otro", isWorkingDay: false }, T);
    expect(p.ok === false && p.errors.join()).toMatch(/fuera del curso/);
  });

  it("borrar un día de Navidad o todo el periodo", () => {
    const cal = confirmedSeed();
    const one = cal.entries.find((e) => e.date === "2026-12-28")!;
    const single = planDeleteEntry(cal, one.id, T);
    expect(single.ok && single.op.entries).toHaveLength(1);
    const all = planDeleteEntry(cal, one.id, T, true);
    expect(all.ok && all.op.entries).toHaveLength(18);
  });
});

describe("cambios que afectan a semanas ya calculadas", () => {
  it("confirmar el 12/10 como no laborable cambia solo la semana del 12/10/2026", () => {
    const before = { "2026-27": seedCalendar2026_27(T) };
    const after = { "2026-27": confirmedSeed() };
    const changes = laborabilityChanges(config, before, after, ["2026-10-12", "2026-10-13"]);
    expect(changes).toEqual([{ date: "2026-10-12", before: true, after: false }]);
    expect(affectedWeeks(changes)).toEqual(["2026-10-12"]);
  });

  it("la Navidad afecta a tres semanas", () => {
    const before = { "2026-27": seedCalendar2026_27(T) };
    const after = { "2026-27": confirmedSeed() };
    const dates = after["2026-27"].entries.filter((e) => e.name === "Vacaciones de Navidad").map((e) => e.date);
    expect(affectedWeeks(laborabilityChanges(config, before, after, dates))).toEqual(["2026-12-21", "2026-12-28", "2027-01-04"]);
  });
});
