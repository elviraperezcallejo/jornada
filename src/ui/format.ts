import { DateTime } from "luxon";
import { TIMEZONE, type CivilDate, type UtcDateTime } from "../domain/types";
import type { Category } from "../domain/types";

export { formatHours, formatHoursShort, formatRatio } from "../domain/compute";

const loc = { locale: "es-ES" };
export const madridDt = (utc: UtcDateTime) => DateTime.fromISO(utc, { zone: "utc" }).setZone(TIMEZONE).setLocale("es-ES");
export const civil = (d: CivilDate) => DateTime.fromISO(d, { zone: TIMEZONE, ...loc });

export const time = (utc: UtcDateTime) => madridDt(utc).toFormat("HH:mm");
export const dateLong = (d: CivilDate) => civil(d).toFormat("cccc, d 'de' LLLL");
export const dateShort = (d: CivilDate) => civil(d).toFormat("dd/MM/yyyy");
export const dateTimeShort = (utc: UtcDateTime) => madridDt(utc).toFormat("ccc dd/MM HH:mm");
export const monthName = (ym: string) => DateTime.fromISO(`${ym}-01`, { zone: TIMEZONE, ...loc }).toFormat("LLLL yyyy");
export const weekLabel = (monday: CivilDate) => {
  const m = civil(monday);
  return `Semana del ${m.toFormat("d 'de' LLLL")} al ${m.plus({ days: 6 }).toFormat("d 'de' LLLL")}`;
};

/** Valor para <input type="datetime-local"> en hora de Madrid (independiente de la zona del dispositivo). */
export const toInputValue = (utc: UtcDateTime) => madridDt(utc).toFormat("yyyy-MM-dd'T'HH:mm");
/** Lee un <input type="datetime-local"> como hora de Madrid. */
export const fromInputValue = (v: string): UtcDateTime | null => {
  const d = DateTime.fromISO(v, { zone: TIMEZONE });
  return d.isValid ? d.toUTC().toISO()! : null;
};

export const CATEGORY_LABEL: Record<Category, string> = {
  nacional_regional: "Festivo nacional o regional",
  uva_no_lectivo: "No lectivo en la UVa",
  local: "Fiesta local",
  centro: "Fiesta de centro",
  periodo_vacacional: "Periodo vacacional",
  academico: "Fecha académica",
  vacaciones_contrato: "Vacaciones",
  permiso_personal: "Permiso personal",
  compensacion: "Día de compensación",
  otro: "Otro",
};

export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Clase de color para una diferencia: positiva, negativa o neutra (menos de 1 minuto). */
export const tone = (h: number) => (Math.abs(h) < 1 / 120 ? "" : h > 0 ? "pos" : "neg");
