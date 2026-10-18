import { defaultConfig, emptyCalendar, seedCalendar2026_27 } from "../src/domain/defaults";
import {
  validateCalendarFile,
  validateCarryoverFile,
  validateConfigFile,
  validateSessionsFile,
} from "../src/domain/validate";
import { SCHEMA_VERSION, type SessionsFile, type WorkSession } from "../src/domain/types";

const T = "2026-10-16T10:00:00.000Z";
const s = (id: string, start: string, end: string | null, extra: Partial<WorkSession> = {}): WorkSession => ({
  id,
  updatedAt: T,
  start,
  end,
  origin: "boton",
  ...extra,
});
const file = (sessions: WorkSession[], month = "2026-10"): SessionsFile => ({
  schemaVersion: SCHEMA_VERSION,
  month,
  sessions,
});

describe("fichero de fichajes", () => {
  it("acepta una jornada con pausa (dos sesiones) y una abierta", () => {
    const f = file([
      s("a", "2026-10-16T06:00:00.000Z", "2026-10-16T09:00:00.000Z"),
      s("b", "2026-10-16T09:30:00.000Z", "2026-10-16T12:00:00.000Z"),
      s("c", "2026-10-16T13:00:00.000Z", null),
    ]);
    expect(validateSessionsFile(f)).toEqual([]);
  });

  it("rechaza una salida anterior a la entrada", () => {
    const errs = validateSessionsFile(file([s("a", "2026-10-16T09:00:00.000Z", "2026-10-16T08:00:00.000Z")]));
    expect(errs.join()).toMatch(/posterior a la entrada/);
  });

  it("rechaza dos fichajes abiertos (fichar 'Entrar' dos veces)", () => {
    const errs = validateSessionsFile(
      file([s("a", "2026-10-16T06:00:00.000Z", null), s("b", "2026-10-16T07:00:00.000Z", null)]),
    );
    expect(errs.join()).toMatch(/más de un fichaje abierto/);
  });

  it("rechaza fichajes solapados", () => {
    const errs = validateSessionsFile(
      file([
        s("a", "2026-10-16T06:00:00.000Z", "2026-10-16T09:00:00.000Z"),
        s("b", "2026-10-16T08:00:00.000Z", "2026-10-16T10:00:00.000Z"),
      ]),
    );
    expect(errs.join()).toMatch(/se solapan/);
  });

  it("ignora los borrados (lápidas) al comprobar solapes", () => {
    const f = file([
      s("a", "2026-10-16T06:00:00.000Z", "2026-10-16T09:00:00.000Z", { deleted: true }),
      s("b", "2026-10-16T08:00:00.000Z", "2026-10-16T10:00:00.000Z"),
    ]);
    expect(validateSessionsFile(f)).toEqual([]);
  });

  it("acepta un fichaje que cruza medianoche: va al mes de la entrada", () => {
    const f = file([s("a", "2026-10-31T21:00:00.000Z", "2026-11-01T00:00:00.000Z")]);
    expect(validateSessionsFile(f)).toEqual([]);
  });

  it("rechaza un fichaje guardado en el fichero de otro mes", () => {
    const errs = validateSessionsFile(file([s("a", "2026-11-03T08:00:00.000Z", null)], "2026-10"));
    expect(errs.join()).toMatch(/no cae en 2026-10/);
  });

  it("rechaza fechas que no están en UTC", () => {
    const errs = validateSessionsFile(file([s("a", "2026-10-16T08:00:00+02:00", null)]));
    expect(errs.join()).toMatch(/start no es/);
  });
});

describe("configuración", () => {
  it("la configuración por defecto es válida (37,5 h, lunes a viernes)", () => {
    const c = defaultConfig(T);
    expect(validateConfigFile(c)).toEqual([]);
    expect(c.contractTerms[0]).toMatchObject({ weeklyHours: 37.5, workdays: [1, 2, 3, 4, 5] });
  });

  it("incluye 22 días de vacaciones y 3 de permiso personal por año natural", () => {
    expect(defaultConfig(T).contractTerms[0]!.leaveAllowances).toEqual([
      { category: "vacaciones_contrato", days: 22, period: "anio_natural" },
      { category: "permiso_personal", days: 3, period: "anio_natural" },
    ]);
  });

  it("acepta días ya usados fuera de la app y rechaza repetidos", () => {
    const c = defaultConfig(T);
    c.priorLeaveUsage = [{ periodKey: "2026", category: "permiso_personal", days: 1 }];
    expect(validateConfigFile(c)).toEqual([]);
    c.priorLeaveUsage.push({ periodKey: "2026", category: "permiso_personal", days: 2 });
    expect(validateConfigFile(c).join()).toMatch(/repetido/);
  });

  it("rechaza cupos repetidos, negativos o con periodo desconocido", () => {
    const c = defaultConfig(T);
    c.contractTerms[0]!.leaveAllowances = [
      { category: "permiso_personal", days: 3, period: "curso" },
      { category: "permiso_personal", days: -1, period: "trimestre" as never },
    ];
    const errs = validateConfigFile(c).join();
    expect(errs).toMatch(/categoría repetida/);
    expect(errs).toMatch(/entero entre 0 y 366/);
    expect(errs).toMatch(/period debe ser/);
  });

  it("la vista anual por defecto es el curso y se puede cambiar a año natural", () => {
    const c = defaultConfig(T);
    expect(c.annualView).toBe("curso");
    c.annualView = "anio_natural";
    expect(validateConfigFile(c)).toEqual([]);
    c.annualView = "trimestre" as never;
    expect(validateConfigFile(c).join()).toMatch(/annualView/);
  });

  it("rechaza 0 horas semanales y días repetidos", () => {
    const c = defaultConfig(T);
    c.contractTerms[0]!.weeklyHours = 0;
    c.contractTerms[0]!.workdays = [1, 1];
    const errs = validateConfigFile(c).join();
    expect(errs).toMatch(/weeklyHours/);
    expect(errs).toMatch(/workdays/);
  });

  it("rechaza coma como separador CSV y como decimal a la vez", () => {
    const c = defaultConfig(T);
    c.export = { csvSeparator: ",", decimalComma: true };
    expect(validateConfigFile(c).join()).toMatch(/a la vez/);
  });
});

describe("calendario por curso", () => {
  it("los datos semilla 2026-27 son válidos y quedan como propuesta sin decidir", () => {
    const cal = seedCalendar2026_27(T);
    expect(validateCalendarFile(cal)).toEqual([]);
    expect(cal.entries.every((e) => e.status === "propuesta" && e.isWorkingDay === null)).toBe(true);
    expect(cal.entries.find((e) => e.date === "2026-10-12")?.name).toBe("Fiesta Nacional de España");
  });

  it("expande los rangos día a día con un mismo grupo (Navidad = 18 días)", () => {
    const navidad = seedCalendar2026_27(T).entries.filter((e) => e.name === "Vacaciones de Navidad");
    expect(navidad).toHaveLength(18);
    expect(navidad[0]!.date).toBe("2026-12-24");
    expect(navidad.at(-1)!.date).toBe("2027-01-10");
    expect(new Set(navidad.map((e) => e.groupId)).size).toBe(1);
  });

  it("rechaza fechas fuera del curso", () => {
    const cal = emptyCalendar("2026-27");
    cal.entries.push({
      id: "x", updatedAt: T, date: "2027-09-01", category: "otro", isTransfer: false,
      origin: "manual", isWorkingDay: false, status: "confirmada",
    });
    expect(validateCalendarFile(cal).join()).toMatch(/fuera del curso/);
  });

  it("rechaza un día de compensación marcado como no laborable", () => {
    const cal = emptyCalendar("2026-27");
    cal.entries.push({
      id: "x", updatedAt: T, date: "2026-10-23", category: "compensacion", isTransfer: false,
      origin: "manual", isWorkingDay: false, status: "confirmada",
    });
    expect(validateCalendarFile(cal).join()).toMatch(/compensación/);
  });

  it("acepta un permiso personal y rechaza dos ausencias el mismo día", () => {
    const cal = emptyCalendar("2026-27");
    const leave = (id: string, category: "permiso_personal" | "vacaciones_contrato") => ({
      id, updatedAt: T, date: "2026-11-20", category, isTransfer: false,
      origin: "manual", isWorkingDay: false, status: "confirmada" as const,
    });
    cal.entries.push(leave("p", "permiso_personal"));
    expect(validateCalendarFile(cal)).toEqual([]);
    cal.entries.push(leave("v", "vacaciones_contrato"));
    expect(validateCalendarFile(cal).join()).toMatch(/ya hay vacaciones o un permiso/);
  });

  it("rechaza unas vacaciones marcadas como laborables", () => {
    const cal = emptyCalendar("2026-27");
    cal.entries.push({
      id: "v", updatedAt: T, date: "2027-08-02", category: "vacaciones_contrato", isTransfer: false,
      origin: "manual", isWorkingDay: true, status: "confirmada",
    });
    expect(validateCalendarFile(cal).join()).toMatch(/no pueden ser día laborable/);
  });

  it("rechaza una fecha confirmada sin decidir si es laborable", () => {
    const cal = emptyCalendar("2026-27");
    cal.entries.push({
      id: "x", updatedAt: T, date: "2026-10-12", category: "nacional_regional", isTransfer: false,
      origin: "manual", isWorkingDay: null, status: "confirmada",
    });
    expect(validateCalendarFile(cal).join()).toMatch(/confirmada debe indicar/);
  });
});

describe("traslado de saldo", () => {
  const base = {
    schemaVersion: SCHEMA_VERSION, course: "2027-28", fromCourse: "2026-27",
    hours: 10, sourceBalanceAtTransfer: 12.5, createdAt: T, updatedAt: T,
  };

  it("acepta trasladar parte de un saldo positivo", () => {
    expect(validateCarryoverFile(base)).toEqual([]);
  });

  it("acepta trasladar un déficit", () => {
    expect(validateCarryoverFile({ ...base, hours: -3, sourceBalanceAtTransfer: -5 })).toEqual([]);
  });

  it("rechaza trasladar más que el saldo o con signo contrario", () => {
    expect(validateCarryoverFile({ ...base, hours: 13 }).join()).toMatch(/entre 0 y el saldo/);
    expect(validateCarryoverFile({ ...base, hours: -1 }).join()).toMatch(/entre 0 y el saldo/);
  });

  it("solo desde el curso inmediatamente anterior", () => {
    expect(validateCarryoverFile({ ...base, fromCourse: "2025-26" }).join()).toMatch(/inmediatamente anterior/);
  });
});
