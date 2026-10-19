import {
  annualSummary,
  compensationSummary,
  buildCarryover,
  carryoverDrift,
  courseBalance,
  daySummary,
  formatHours,
  formatRatio,
  leaveUsage,
  monthSummary,
  monthsOf,
  weekChanges,
  weekSummary,
  weeksOf,
  type CalcContext,
} from "../src/domain/compute";
import { applyCalendarOp, planAddEntries, planAddLeaveDays, planConfirm, type Calendars } from "../src/domain/calendar";
import { defaultConfig, emptyCalendar, seedCalendar2026_27 } from "../src/domain/defaults";
import { validateCarryoverFile } from "../src/domain/validate";
import type { CalendarFile, WorkSession } from "../src/domain/types";

const T = "2026-10-16T10:00:00.000Z";
// En las pruebas se registra desde el inicio del curso, salvo que se indique lo contrario.
const config = { ...defaultConfig(T), trackingStartsOn: "2026-09-01" };
const utc = (local: string) => new Date(local).toISOString(); // local con desfase explícito, p. ej. "2026-10-05T08:00+02:00"

let n = 0;
const ses = (start: string, end: string | null): WorkSession => ({
  id: `s${++n}`, updatedAt: T, start: utc(start), end: end === null ? null : utc(end), origin: "boton",
});
/** Jornada de 08:00 a 15:30 (7,5 h) en un día con el desfase de Madrid indicado. */
const day = (date: string, tz = "+02:00") => ses(`${date}T08:00${tz}`, `${date}T15:30${tz}`);

/** Calendario semilla con todo (salvo lo académico) confirmado como no laborable. */
function confirmed(): CalendarFile {
  const cal = seedCalendar2026_27(T);
  const p = planConfirm(cal, "2026-27", cal.entries.filter((e) => e.category !== "academico").map((entry) => ({ entry, isWorkingDay: false })), T);
  if (!p.ok) throw new Error(p.errors.join());
  return applyCalendarOp(cal, p.op);
}

const ctx = (sessions: WorkSession[], now: string, calendars: Calendars = { "2026-27": confirmed() }): CalcContext => ({
  config, calendars, sessions, now: utc(now),
});

// ---------------------------------------------------------------------------
// Casos pedidos en el enunciado
// ---------------------------------------------------------------------------

describe("1. semana completa (05–11/10/2026)", () => {
  const s = weekSummary("2026-10-07", ctx(["05", "06", "07", "08", "09"].map((d) => day(`2026-10-${d}`)), "2026-10-16T12:00+02:00"));

  it("37,5 h trabajadas frente a 37,5 h de referencia: diferencia 0", () => {
    expect(s.from).toBe("2026-10-05");
    expect(s.to).toBe("2026-10-11");
    expect(s.workedHours).toBe(37.5);
    expect(s.referenceHours).toBe(37.5);
    expect(s.workdays).toBe(5);
    expect(s.diffHours).toBe(0);
    expect(s.diffRatio).toBe(0);
  });
});

describe("2. semana con festivo nacional (12/10/2026)", () => {
  const sessions = ["13", "14", "15", "16"].map((d) => day(`2026-10-${d}`));

  it("la referencia baja a 30 h (4 días laborables)", () => {
    const s = weekSummary("2026-10-12", ctx(sessions, "2026-10-19T09:00+02:00"));
    expect(s.workdays).toBe(4);
    expect(s.referenceHours).toBe(30);
    expect(s.workedHours).toBe(30);
    expect(s.diffHours).toBe(0);
  });

  it("si se trabaja el festivo, suma al total y aparece aparte", () => {
    const extra = ses("2026-10-12T09:00+02:00", "2026-10-12T13:00+02:00");
    const s = weekSummary("2026-10-12", ctx([...sessions, extra], "2026-10-19T09:00+02:00"));
    expect(s.workedHours).toBe(34);
    expect(s.workedOnNonWorkdays).toBe(4);
    expect(s.diffHours).toBe(4);
    expect(formatRatio(s.diffRatio)).toBe("+13,3 %");
  });

  it("si el 12/10 está solo propuesto (sin confirmar), no reduce la referencia y se avisa", () => {
    const s = weekSummary("2026-10-12", ctx(sessions, "2026-10-19T09:00+02:00", { "2026-27": seedCalendar2026_27(T) }));
    expect(s.referenceHours).toBe(37.5);
    expect(s.undecidedDates).toEqual(["2026-10-12"]);
  });
});

describe("3. semanas con vacaciones de Navidad", () => {
  const now = "2027-01-15T12:00+01:00";

  it("28/12/2026–03/01/2027: todo no laborable → referencia 0 y porcentaje «no aplica»", () => {
    const s = weekSummary("2026-12-30", ctx([], now));
    expect(s.referenceHours).toBe(0);
    expect(s.diffHours).toBe(0);
    expect(s.diffRatio).toBeNull();
    expect(formatRatio(s.diffRatio)).toBe("no aplica");
  });

  it("21–27/12/2026: solo lunes a miércoles son laborables → 22,5 h", () => {
    const s = weekSummary("2026-12-21", ctx(["21", "22", "23"].map((d) => day(`2026-12-${d}`, "+01:00")), now));
    expect(s.referenceHours).toBe(22.5);
    expect(s.diffHours).toBe(0);
  });

  it("trabajar un día de Navidad suma como horas de más", () => {
    const s = weekSummary("2026-12-30", ctx([day("2026-12-30", "+01:00")], now));
    expect(s.workedHours).toBe(7.5);
    expect(s.workedOnNonWorkdays).toBe(7.5);
    expect(s.diffHours).toBe(7.5);
    expect(s.diffRatio).toBeNull();
  });
});

describe("4. fichaje sin salida", () => {
  const open = ses("2026-10-14T08:00+02:00", null);

  it("de un día anterior: no suma ninguna hora y queda señalado para corregir", () => {
    const s = weekSummary("2026-10-14", ctx([open], "2026-10-16T10:00+02:00"));
    expect(s.workedHours).toBe(0);
    expect(s.pendingSessions.map((p) => p.id)).toEqual([open.id]);
    expect(daySummary("2026-10-14", ctx([open], "2026-10-16T10:00+02:00")).pendingSessions).toHaveLength(1);
  });

  it("de hoy: suma hasta ahora y se marca como provisional", () => {
    const s = daySummary("2026-10-14", ctx([open], "2026-10-14T11:30+02:00"));
    expect(s.workedHours).toBe(3.5);
    expect(s.provisional).toBe(true);
    expect(s.pendingSessions).toEqual([]);
  });
});

describe("5. fichaje que cruza la medianoche", () => {
  it("22:00–01:00 reparte 2 h a un día y 1 h al siguiente", () => {
    const c = ctx([ses("2026-10-16T22:00+02:00", "2026-10-17T01:00+02:00")], "2026-10-20T10:00+02:00");
    expect(daySummary("2026-10-16", c).workedHours).toBe(2);
    expect(daySummary("2026-10-17", c).workedHours).toBe(1);
  });

  it("de domingo a lunes, cada parte va a su semana", () => {
    const c = ctx([ses("2026-10-18T22:00+02:00", "2026-10-19T01:00+02:00")], "2026-10-25T10:00+01:00");
    expect(weekSummary("2026-10-18", c).workedHours).toBe(2);
    expect(weekSummary("2026-10-19", c).workedHours).toBe(1);
  });

  it("del 31/01 al 01/02/2027, cada parte va a su mes y a su semana", () => {
    const c = ctx([ses("2027-01-31T22:00+01:00", "2027-02-01T02:00+01:00")], "2027-02-10T10:00+01:00");
    expect(monthSummary("2027-01", c).workedHours).toBe(2);
    expect(monthSummary("2027-02", c).workedHours).toBe(2);
    expect(weekSummary("2027-01-31", c).workedHours).toBe(2);
    expect(weekSummary("2027-02-01", c).workedHours).toBe(2);
  });

  it("el día del cambio de hora (25/10/2026) cuenta el tiempo real: 00:30 a 03:30 son 4 h", () => {
    const c = ctx([ses("2026-10-25T00:30+02:00", "2026-10-25T03:30+01:00")], "2026-10-26T10:00+01:00");
    expect(daySummary("2026-10-25", c).workedHours).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Otros casos
// ---------------------------------------------------------------------------

describe("periodos en curso", () => {
  it("la diferencia usa la referencia hasta hoy; la del periodo completo va aparte", () => {
    // Miércoles 07/10 a mediodía: lunes y martes completos, hoy 4 h.
    const c = ctx([day("2026-10-05"), day("2026-10-06"), ses("2026-10-07T08:00+02:00", null)], "2026-10-07T12:00+02:00");
    const s = weekSummary("2026-10-07", c);
    expect(s.referenceHours).toBe(37.5);
    expect(s.referenceToDate).toBe(22.5);
    expect(s.workedHours).toBe(19);
    expect(s.diffHours).toBe(-3.5);
    expect(s.provisional).toBe(true);
  });
});

describe("vista anual por curso o por año natural", () => {
  const sessions = [day("2026-12-01", "+01:00"), day("2027-03-01", "+01:00")];
  const c = ctx(sessions, "2027-09-15T10:00+02:00");

  it("los mismos fichajes se reparten según la vista", () => {
    expect(annualSummary("2026-27", c).workedHours).toBe(15);
    expect(annualSummary("2026", c).workedHours).toBe(7.5);
    expect(annualSummary("2027", c).workedHours).toBe(7.5);
  });

  it("el año natural 2027 usa un calendario estimado para el curso 2027-28 y lo indica", () => {
    expect(annualSummary("2027", c).estimatedCourses).toEqual(["2027-28"]);
    expect(annualSummary("2027", c).missingCourses).toEqual([]);
    expect(annualSummary("2026-27", c).estimatedCourses).toEqual([]);
  });

  it("con la estimación desactivada, avisa de que falta el calendario del curso 2027-28", () => {
    const off = { ...c, config: { ...config, estimateMissingCalendars: false } };
    expect(annualSummary("2027", off).missingCourses).toEqual(["2027-28"]);
  });

  it("desglosa en meses y semanas", () => {
    const year = annualSummary("2026-27", c);
    expect(monthsOf(year)).toHaveLength(12);
    expect(monthsOf(year).find((m) => m.month === "2026-12")?.summary.workedHours).toBe(7.5);
    const oct = monthSummary("2026-10", c);
    const weeks = weeksOf(oct);
    expect(weeks[0]!.monday).toBe("2026-09-28"); // 01/10/2026 es jueves: semana parcial
    expect(weeks.reduce((a, w) => a + w.summary.referenceHours, 0)).toBe(oct.referenceHours);
  });
});

describe("saldo del curso y traslado", () => {
  const empty = emptyCalendar("2026-27");
  // Contrato de prueba de solo 1 h semanal un día a la semana, para que el saldo sea fácil de seguir.
  const tiny = { ...config, contractTerms: [{ ...config.contractTerms[0]!, weeklyHours: 1, workdays: [1 as const] }] };

  it("calcula el saldo, permite trasladar una parte y avisa si después cambia", () => {
    const sessions = [ses("2027-01-04T08:00+01:00", "2027-01-04T20:00+01:00")]; // 12 h un lunes
    const c: CalcContext = { config: tiny, calendars: { "2026-27": empty }, sessions, now: utc("2027-09-10T10:00+02:00") };
    const bal = courseBalance("2026-27", c, null);
    expect(bal.finished).toBe(true);
    // 52 lunes en el curso × 1 h = 52 h de referencia; 12 trabajadas → −40 h.
    expect(bal.summary.referenceHours).toBe(52);
    expect(bal.ownBalance).toBe(-40);

    const co = buildCarryover(bal, "2027-28", -10, c.now, "parte del déficit");
    expect(validateCarryoverFile(co)).toEqual([]);
    expect(courseBalance("2027-28", { ...c, calendars: {} }, co).carriedIn).toBe(-10);

    expect(carryoverDrift(co, bal)).toBeNull();
    const corrected = courseBalance("2026-27", { ...c, sessions: [...sessions, ses("2027-01-11T08:00+01:00", "2027-01-11T10:00+01:00")] }, null);
    expect(carryoverDrift(co, corrected)).toEqual({ before: -40, now: -38 });
  });
});

describe("cupos de vacaciones y permisos", () => {
  it("cuenta usados, planificados, días previos y restantes por año natural", () => {
    const base = confirmed();
    const p1 = planAddLeaveDays(base, "2026-27", ["2026-10-09", "2026-11-20"], "permiso_personal", T);
    if (!p1.ok) throw new Error(p1.errors.join());
    const cal = applyCalendarOp(base, p1.op);
    const c: CalcContext = {
      config: { ...config, priorLeaveUsage: [{ periodKey: "2026", category: "permiso_personal", days: 1 }] },
      calendars: { "2026-27": cal }, sessions: [], now: utc("2026-10-16T10:00+02:00"),
    };
    const u = leaveUsage("permiso_personal", "2026", c);
    expect(u).toMatchObject({ allowance: 3, prior: 1, used: 1, planned: 1, remaining: 0 });
    expect(u.usedDates).toEqual(["2026-10-09"]);
  });

  it("agosto de 2027 completo gasta los 22 días de 2027 y avisa de que 2027-28 es estimado", () => {
    const base = confirmed();
    const aug = Array.from({ length: 31 }, (_, i) => `2027-08-${String(i + 1).padStart(2, "0")}`);
    const p = planAddLeaveDays(base, "2026-27", aug, "vacaciones_contrato", T);
    if (!p.ok) throw new Error(p.errors.join());
    const c = ctx([], "2026-10-16T10:00+02:00", { "2026-27": applyCalendarOp(base, p.op) });
    const u = leaveUsage("vacaciones_contrato", "2027", c);
    expect(u.planned).toBe(22); // los fines de semana marcados no gastan cupo
    expect(u.remaining).toBe(0);
    expect(u.estimatedCourses).toEqual(["2027-28"]);
    expect(u.missingCourses).toEqual([]);
    // y esos días no tienen referencia: agosto no genera déficit
    expect(monthSummary("2027-08", c).referenceHours).toBe(0);
  });
});

describe("aviso de cambios del calendario con horas", () => {
  it("marcar un viernes como día no laborable reduce la referencia de su semana en 7,5 h", () => {
    const base = confirmed();
    const p = planAddEntries(base, "2026-27", { from: "2026-10-09", category: "otro", name: "Cierre", isWorkingDay: false }, T);
    if (!p.ok) throw new Error(p.errors.join());
    const c = ctx(["05", "06", "07", "08", "09"].map((d) => day(`2026-10-${d}`)), "2026-10-16T10:00+02:00", { "2026-27": base });
    const [w] = weekChanges(["2026-10-05"], c, { "2026-27": applyCalendarOp(base, p.op) });
    expect(w).toEqual({ monday: "2026-10-05", workedHours: 37.5, referenceBefore: 37.5, referenceAfter: 30, diffBefore: 0, diffAfter: 7.5 });
  });
});

describe("formato", () => {
  it("horas y minutos con signo, y porcentajes en español", () => {
    expect(formatHours(7.5)).toBe("7 h 30 min");
    expect(formatHours(1.0833, true)).toBe("+1 h 05 min");
    expect(formatHours(-0.75, true)).toBe("−0 h 45 min");
    expect(formatHours(0, true)).toBe("0 h 00 min");
    expect(formatRatio(-0.05)).toBe("−5,0 %");
  });
});

describe("inicio del registro", () => {
  const base = defaultConfig(T); // trackingStartsOn: null
  const sessions = [day("2026-10-14"), day("2026-10-15")];

  it("por defecto cuenta desde el primer fichaje: empezar a mitad de curso no es déficit", () => {
    const c: CalcContext = { config: base, calendars: { "2026-27": confirmed() }, sessions, now: utc("2026-10-16T18:00+02:00") };
    const year = annualSummary("2026-27", c);
    expect(year.referenceToDate).toBe(22.5); // 14, 15 y 16 de octubre
    expect(year.workedHours).toBe(15);
    expect(year.days.find((d) => d.date === "2026-10-13")?.beforeTracking).toBe(true);
  });

  it("con una fecha de inicio fijada, cuenta desde esa fecha", () => {
    const c: CalcContext = { config: { ...base, trackingStartsOn: "2026-10-05" }, calendars: { "2026-27": confirmed() }, sessions, now: utc("2026-10-16T18:00+02:00") };
    expect(annualSummary("2026-27", c).referenceToDate).toBe(75 - 7.5); // dos semanas menos el 12/10
  });

  it("sin fichajes ni fecha, empieza hoy", () => {
    const c: CalcContext = { config: base, calendars: { "2026-27": confirmed() }, sessions: [], now: utc("2026-10-16T18:00+02:00") };
    expect(weekSummary("2026-10-16", c).referenceToDate).toBe(7.5);
  });
});

describe("días de compensación generados", () => {
  // Contrato normal; registro desde el 05/10/2026; calendario con festivos confirmados.
  const cal = confirmed();
  const sessions = [
    ...["05", "06", "07", "08", "09"].map((d) => ses(`2026-10-${d}T08:00+02:00`, `2026-10-${d}T19:00+02:00`)), // 11 h al día
  ];
  const now = "2026-10-09T20:00+02:00";
  const cfg = { ...config, trackingStartsOn: "2026-10-05" };

  it("el saldo positivo se traduce en días de 7,5 h", () => {
    const c = compensationSummary("2026-27", { config: cfg, calendars: { "2026-27": cal }, sessions, now: utc(now) }, null);
    expect(c.dailyHours).toBe(7.5);
    expect(c.balanceHours).toBe(17.5); // 55 h trabajadas − 37,5 h
    expect(c.availableDays).toBeCloseTo(17.5 / 7.5);
  });

  it("un día de compensación planificado se resta; uno ya disfrutado ya está en el saldo", () => {
    const p = planAddLeaveDays(cal, "2026-27", ["2026-10-16", "2026-11-06"], "compensacion", T);
    if (!p.ok) throw new Error(p.errors.join());
    const withComp = applyCalendarOp(cal, p.op);
    const at = (n: string) => compensationSummary("2026-27", { config: cfg, calendars: { "2026-27": withComp }, sessions, now: utc(n) }, null);
    const before = at(now); // los dos son futuros
    expect(before.plannedDates).toEqual(["2026-10-16", "2026-11-06"]);
    expect(before.availableHours).toBe(17.5 - 15);
    // El 16/10 ya pasó: está dentro del saldo (referencia de la semana sin trabajar ese día).
    const after = at("2026-10-17T10:00+02:00");
    expect(after.takenDates).toEqual(["2026-10-16"]);
    expect(after.plannedDates).toEqual(["2026-11-06"]);
  });

  it("el traslado del curso anterior suma al saldo", () => {
    const c = compensationSummary("2026-27", { config: cfg, calendars: { "2026-27": cal }, sessions, now: utc(now) },
      { schemaVersion: 1, course: "2026-27", fromCourse: "2025-26", hours: 7.5, sourceBalanceAtTransfer: 10, createdAt: T, updatedAt: T });
    expect(c.carriedIn).toBe(7.5);
    expect(c.balanceHours).toBe(25);
  });
});
