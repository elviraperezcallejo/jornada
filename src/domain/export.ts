import { live } from "./sessions";
import { toMadrid } from "./time";
import type { PeriodSummary } from "./compute";
import type { CalendarFile, CarryoverFile, ConfigFile, ExportSettings, WorkSession } from "./types";

/**
 * Exportación:
 * - copia completa en JSON (se puede volver a importar);
 * - CSV de fichajes y CSV de resúmenes, con separador y decimales según
 *   Ajustes (por defecto ";" y coma decimal, lo habitual con Excel en
 *   español; depende de la configuración regional del equipo).
 * Los CSV llevan BOM UTF-8 para que Excel muestre bien tildes y eñes.
 */

const BOM = "\uFEFF";

function cell(v: string | number, s: ExportSettings): string {
  let text = typeof v === "number" ? num(v, s) : v;
  // Entre comillas solo si contiene el separador, comillas o saltos de línea.
  if (text.includes(s.csvSeparator) || /["\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

function num(v: number, s: ExportSettings): string {
  const t = (Math.round(v * 100) / 100).toFixed(2);
  return s.decimalComma ? t.replace(".", ",") : t;
}

function csv(rows: (string | number)[][], s: ExportSettings): string {
  return BOM + rows.map((r) => r.map((c) => cell(c, s)).join(s.csvSeparator)).join("\r\n") + "\r\n";
}

/** Un renglón por fichaje (sin los borrados), en hora de Madrid. */
export function sessionsCsv(sessions: WorkSession[], s: ExportSettings): string {
  const rows: (string | number)[][] = [["Fecha", "Entrada", "Salida", "Horas", "Origen", "Nota"]];
  for (const x of [...live(sessions)].sort((a, b) => a.start.localeCompare(b.start))) {
    const start = toMadrid(x.start);
    const end = x.end ? toMadrid(x.end) : null;
    const hours = end ? end.diff(start, "hours").hours : 0;
    rows.push([
      start.toFormat("dd/MM/yyyy"),
      start.toFormat("HH:mm"),
      end ? (end.hasSame(start, "day") ? end.toFormat("HH:mm") : end.toFormat("dd/MM/yyyy HH:mm")) : "SIN SALIDA",
      hours,
      x.origin,
      x.note ?? "",
    ]);
  }
  return csv(rows, s);
}

/** Un renglón por periodo (días, semanas o meses de un resumen). */
export function summaryCsv(rows: { label: string; summary: PeriodSummary }[], s: ExportSettings): string {
  const out: (string | number)[][] = [[
    "Periodo", "Desde", "Hasta", "Horas trabajadas", "Horas de referencia", "Referencia hasta hoy",
    "Diferencia (h)", "Diferencia (%)", "Horas en días no laborables", "Días laborables",
  ]];
  for (const { label, summary: p } of rows) {
    out.push([
      label, p.from, p.to, p.workedHours, p.referenceHours, p.referenceToDate, p.diffHours,
      p.diffRatio === null ? "no aplica" : p.diffRatio * 100, p.workedOnNonWorkdays, String(p.workdays),
    ]);
  }
  return csv(out, s);
}

export interface FullBackup {
  app: "jornada-uva";
  exportedAt: string;
  config: ConfigFile;
  calendars: CalendarFile[];
  carryovers: CarryoverFile[];
  /** Incluye borrados (lápidas) para poder restaurar exactamente. */
  sessions: WorkSession[];
}

export function fullBackup(
  config: ConfigFile,
  calendars: CalendarFile[],
  carryovers: CarryoverFile[],
  sessions: WorkSession[],
  now: string,
): string {
  const b: FullBackup = { app: "jornada-uva", exportedAt: now, config, calendars, carryovers, sessions };
  return JSON.stringify(b, null, 2);
}
