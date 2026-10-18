import { sessionsCsv, summaryCsv, fullBackup } from "../src/domain/export";
import { weekSummary } from "../src/domain/compute";
import { defaultConfig, emptyCalendar } from "../src/domain/defaults";
import type { WorkSession } from "../src/domain/types";

const T = "2026-10-16T10:00:00.000Z";
const es = { csvSeparator: ";" as const, decimalComma: true };
const s = (id: string, start: string, end: string | null, note?: string): WorkSession => ({
  id, updatedAt: T, start: new Date(start).toISOString(), end: end && new Date(end).toISOString(), origin: "boton", note,
});

describe("exportación CSV", () => {
  const sessions = [
    s("b", "2026-10-16T22:00+02:00", "2026-10-17T01:00+02:00", 'turno "noche"; extra'),
    s("a", "2026-10-15T08:00+02:00", "2026-10-15T15:30+02:00"),
    s("c", "2026-10-19T08:00+02:00", null),
    { ...s("d", "2026-10-14T08:00+02:00", "2026-10-14T09:00+02:00"), deleted: true },
  ];

  it("fichajes en hora de Madrid, con coma decimal, BOM y sin los borrados", () => {
    const out = sessionsCsv(sessions, es);
    expect(out.startsWith("\uFEFF")).toBe(true);
    expect(out.split("\r\n").slice(0, 4)).toEqual([
      "\uFEFFFecha;Entrada;Salida;Horas;Origen;Nota",
      "15/10/2026;08:00;15:30;7,50;boton;",
      '16/10/2026;22:00;17/10/2026 01:00;3,00;boton;"turno ""noche""; extra"',
      "19/10/2026;08:00;SIN SALIDA;0,00;boton;",
    ]);
  });

  it("con separador coma y punto decimal", () => {
    expect(sessionsCsv([sessions[1]!], { csvSeparator: ",", decimalComma: false }).split("\r\n")[1]).toBe(
      "15/10/2026,08:00,15:30,7.50,boton,",
    );
  });

  it("resúmenes por periodo con horas, referencia y diferencias", () => {
    const ctx = { config: { ...defaultConfig(T), trackingStartsOn: "2026-09-01" }, calendars: { "2026-27": emptyCalendar("2026-27") }, sessions, now: T };
    const out = summaryCsv([{ label: "Semana 12/10", summary: weekSummary("2026-10-12", ctx) }], es);
    expect(out.split("\r\n")[1]).toMatch(/^Semana 12\/10;2026-10-12;2026-10-18;10,50;37,50;37,50;-27,00;-72,00;1,00;5$/);
  });
});

describe("copia completa", () => {
  it("incluye todo, también los borrados, y se puede volver a leer", () => {
    const json = fullBackup(defaultConfig(T), [emptyCalendar("2026-27")], [], [s("a", "2026-10-15T08:00+02:00", null)], T);
    const back = JSON.parse(json);
    expect(back.app).toBe("jornada-uva");
    expect(back.calendars[0].course).toBe("2026-27");
    expect(back.sessions).toHaveLength(1);
  });
});

it("en el CSV de resúmenes, una referencia 0 aparece como «no aplica»", () => {
  const ctx = { config: defaultConfig(T), calendars: { "2026-27": emptyCalendar("2026-27") }, sessions: [], now: T };
  const sat = weekSummary("2026-10-17", ctx);
  const out = summaryCsv([{ label: "Sábado", summary: { ...sat, referenceToDate: 0, diffRatio: null } }], es);
  expect(out.split("\r\n")[1]).toContain(";no aplica;");
});
