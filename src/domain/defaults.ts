import { DateTime } from "luxon";
import { newId } from "./ids";
import { courseBounds, nowUtc } from "./time";
import {
  SCHEMA_VERSION,
  TIMEZONE,
  type CalendarEntry,
  type CalendarFile,
  type Category,
  type CivilDate,
  type ConfigFile,
  type CourseLabel,
} from "./types";

/**
 * Configuración inicial (todo editable desde Ajustes).
 * Cupos confirmados por el usuario: 22 días hábiles de vacaciones y 3 de
 * permiso por causas personales, por año natural. Navidad y Semana Santa no
 * descuentan (son categorías aparte).
 * PENDIENTE: fecha real de inicio del contrato (se usa el inicio del curso
 * 2026-27).
 */
export function defaultConfig(now = nowUtc()): ConfigFile {
  return {
    schemaVersion: SCHEMA_VERSION,
    timezone: TIMEZONE,
    contractTerms: [
      {
        validFrom: "2026-09-01",
        weeklyHours: 37.5,
        workdays: [1, 2, 3, 4, 5],
        leaveAllowances: [
          { category: "vacaciones_contrato", days: 22, period: "anio_natural" },
          { category: "permiso_personal", days: 3, period: "anio_natural" },
        ],
      },
    ],
    priorLeaveUsage: [],
    trackingStartsOn: null,
    annualView: "curso",
    estimateMissingCalendars: true,
    calendarImport: { campus: "Valladolid", centre: "Facultad de Ciencias" },
    export: { csvSeparator: ";", decimalComma: true },
    updatedAt: now,
  };
}

export function emptyCalendar(course: CourseLabel, sourceName?: string): CalendarFile {
  const { startsOn, endsOn } = courseBounds(course);
  return { schemaVersion: SCHEMA_VERSION, course, startsOn, endsOn, sourceName, entries: [] };
}

interface SeedItem {
  from: CivilDate;
  to?: CivilDate;
  category: Category;
  name?: string;
  isTransfer?: boolean;
}

/**
 * Datos semilla 2026-27 proporcionados por el usuario (SOLO PARA PRUEBAS).
 * Todas las fechas entran como "propuesta" y sin decidir si son laborables:
 * el usuario decide. No incluyen los festivos del calendario laboral de
 * Castilla y León 2026 ni 2027 (pendientes de verificar).
 */
const SEED_2026_27: SeedItem[] = [
  { from: "2026-10-12", category: "nacional_regional", name: "Fiesta Nacional de España" },
  { from: "2026-11-02", category: "nacional_regional", name: "Todos los Santos", isTransfer: true },
  { from: "2026-12-07", category: "nacional_regional", name: "Día de la Constitución", isTransfer: true },
  { from: "2026-12-08", category: "nacional_regional", name: "Inmaculada Concepción" },
  { from: "2027-04-23", category: "nacional_regional", name: "Día de Castilla y León" },
  { from: "2027-05-01", category: "nacional_regional", name: "Día del Trabajo" },
  { from: "2026-10-30", category: "uva_no_lectivo" },
  { from: "2026-12-04", category: "uva_no_lectivo", name: "San Nicolás de Bari" },
  { from: "2027-01-29", category: "uva_no_lectivo", name: "Santo Tomás de Aquino", isTransfer: true },
  { from: "2026-12-24", to: "2027-01-10", category: "periodo_vacacional", name: "Vacaciones de Navidad" },
  { from: "2027-03-20", to: "2027-03-30", category: "periodo_vacacional", name: "Semana Santa" },
  { from: "2026-09-08", category: "local", name: "Virgen de San Lorenzo" },
  { from: "2027-05-13", category: "local", name: "San Pedro Regalado" },
  { from: "2026-11-13", category: "centro", name: "San Alberto", isTransfer: true },
  { from: "2026-09-07", category: "academico", name: "Inicio de clases de grado" },
  { from: "2027-02-08", category: "academico", name: "Inicio del 2.º cuatrimestre" },
  { from: "2026-12-18", category: "academico", name: "Fin de clases (1.er cuatrimestre)" },
  { from: "2027-05-28", category: "academico", name: "Fin de clases (2.º cuatrimestre)" },
];

export function seedCalendar2026_27(now = nowUtc()): CalendarFile {
  const cal = emptyCalendar("2026-27", "Datos semilla de prueba");
  for (const item of SEED_2026_27) {
    const groupId = item.to ? newId() : undefined;
    let d = DateTime.fromISO(item.from, { zone: TIMEZONE });
    const end = DateTime.fromISO(item.to ?? item.from, { zone: TIMEZONE });
    while (d <= end) {
      const entry: CalendarEntry = {
        id: newId(),
        updatedAt: now,
        date: d.toISODate()!,
        category: item.category,
        isTransfer: item.isTransfer ?? false,
        name: item.name,
        origin: "Datos semilla (enunciado del proyecto)",
        groupId,
        isWorkingDay: null,
        status: "propuesta",
      };
      cal.entries.push(entry);
      d = d.plus({ days: 1 });
    }
  }
  return cal;
}
