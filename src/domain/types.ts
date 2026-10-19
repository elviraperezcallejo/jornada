/**
 * Modelo de datos de la aplicación.
 *
 * Todos los ficheros se guardan como JSON en el repositorio privado de datos
 * del usuario. Las fechas-hora van en UTC (ISO 8601 con "Z"); los cálculos se
 * hacen después en hora de Madrid. Las fechas sin hora van como "AAAA-MM-DD".
 */

export const SCHEMA_VERSION = 1;
export const TIMEZONE = "Europe/Madrid";

/** Instante en UTC, p. ej. "2026-10-16T06:30:00.000Z". */
export type UtcDateTime = string;
/** Fecha civil sin hora, p. ej. "2026-10-12". */
export type CivilDate = string;
/** Mes, p. ej. "2026-10". */
export type YearMonth = string;
/** Curso académico, p. ej. "2026-27". */
export type CourseLabel = string;

/** Campos comunes para poder fusionar cambios de varios dispositivos. */
export interface Syncable {
  /** Identificador único (UUID), generado en el dispositivo. */
  id: string;
  /** Última modificación (UTC). Gana la más reciente al fusionar. */
  updatedAt: UtcDateTime;
  /**
   * Borrado lógico. Un registro borrado se conserva como "lápida" para que
   * otro dispositivo que aún lo tenga no lo resucite al sincronizar.
   */
  deleted?: boolean;
}

// ---------------------------------------------------------------------------
// Fichajes
// ---------------------------------------------------------------------------

export type SessionOrigin = "boton" | "manual" | "offline";

/** Un par entrada/salida. Las pausas son simplemente huecos entre sesiones. */
export interface WorkSession extends Syncable {
  start: UtcDateTime;
  /** null = sesión abierta (fichado). */
  end: UtcDateTime | null;
  origin: SessionOrigin;
  note?: string;
}

/** fichajes/AAAA-MM.json: sesiones cuya ENTRADA cae en ese mes (hora de Madrid). */
export interface SessionsFile {
  schemaVersion: number;
  month: YearMonth;
  sessions: WorkSession[];
}

// ---------------------------------------------------------------------------
// Configuración y contrato
// ---------------------------------------------------------------------------

/** Día ISO de la semana: 1 = lunes … 7 = domingo. */
export type IsoWeekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Periodo al que se refiere un cupo de días (el usuario usa año natural). */
export type AllowancePeriod = "curso" | "anio_natural";

/** Categorías de calendario que consumen un cupo anual de días. */
export type LeaveCategory = "vacaciones_contrato" | "permiso_personal";

/**
 * Cupo de días de un tipo de ausencia. Solo consume cupo un día que, sin
 * esa ausencia, habría sido laborable (no un sábado ni un festivo).
 */
export interface LeaveAllowance {
  category: LeaveCategory;
  days: number;
  period: AllowancePeriod;
}

/**
 * Condiciones del contrato a partir de una fecha. Se versionan para que un
 * cambio de jornada o de cupos no reescriba el pasado.
 */
export interface ContractTerm {
  validFrom: CivilDate;
  weeklyHours: number;
  workdays: IsoWeekday[];
  leaveAllowances: LeaveAllowance[];
}

export interface ExportSettings {
  /** ";" es lo habitual con Excel configurado en español; depende del equipo. */
  csvSeparator: ";" | ",";
  decimalComma: boolean;
}

/**
 * Días de un cupo ya gastados fuera de la app (p. ej. los de 2026 usados
 * antes de empezar a registrar). Se suman a los usados en la app.
 */
export interface PriorLeaveUsage {
  /** Clave del periodo: "2026" (año natural) o "2026-27" (curso). */
  periodKey: string;
  category: LeaveCategory;
  days: number;
}

/** Cómo se agrupa la vista anual. Se puede cambiar en cualquier momento. */
export type AnnualView = "curso" | "anio_natural";

/** Qué fiestas locales y de centro se toman del PDF del calendario académico. */
export interface CalendarImportSettings {
  /** Campus cuyas fiestas locales se importan, p. ej. "Valladolid". */
  campus: string;
  /** Centro cuya fiesta patronal se importa, tal y como aparece en el anexo del PDF. */
  centre: string;
}

/**
 * Perfil del usuario: miembro de la UVa (por defecto) o de otro trabajo.
 * Solo cambia textos y la ayuda de importación; los datos son los mismos.
 */
export type Profile = "uva" | "generico";

/** config.json */
export interface ConfigFile {
  schemaVersion: number;
  timezone: typeof TIMEZONE;
  /** Sin valor = "uva" (ficheros creados antes de existir esta opción). */
  profile?: Profile;
  contractTerms: ContractTerm[];
  priorLeaveUsage: PriorLeaveUsage[];
  /**
   * Primer día que se registra con la app. Los días anteriores no cuentan
   * (ni horas ni referencia), para que empezar a mitad de curso no aparezca
   * como déficit. null = el día del primer fichaje.
   */
  trackingStartsOn: CivilDate | null;
  /** Vista anual preferida (por defecto, curso). Se sincroniza entre dispositivos. */
  annualView: AnnualView;
  /**
   * Si falta el calendario de un curso, estimarlo a partir del anterior
   * (marcado como estimado). Por defecto, sí.
   */
  estimateMissingCalendars: boolean;
  calendarImport: CalendarImportSettings;
  export: ExportSettings;
  updatedAt: UtcDateTime;
}

// ---------------------------------------------------------------------------
// Calendario por curso
// ---------------------------------------------------------------------------

export const CATEGORIES = [
  "nacional_regional",
  "uva_no_lectivo",
  "local",
  "centro",
  "periodo_vacacional",
  "academico",
  /** Vacaciones del contrato (cupo anual). */
  "vacaciones_contrato",
  /** Permiso por causas personales (cupo anual). */
  "permiso_personal",
  /** Día libre para gastar saldo: mantiene la referencia (laborable). */
  "compensacion",
  "otro",
] as const;
export type Category = (typeof CATEGORIES)[number];

export type EntryStatus = "propuesta" | "confirmada";

export interface CalendarEntry extends Syncable {
  date: CivilDate;
  category: Category;
  /** Festivo trasladado. */
  isTransfer: boolean;
  name?: string;
  /** De dónde viene: "PDF calendario académico UVa 2026-27", "manual", … */
  origin: string;
  /** Agrupa los días de un mismo rango (p. ej. vacaciones de Navidad). */
  groupId?: string;
  /** Decisión del usuario. null = aún sin decidir (no afecta a cálculos). */
  isWorkingDay: boolean | null;
  status: EntryStatus;
}

/** cursos/AAAA-AA/calendario.json */
export interface CalendarFile {
  schemaVersion: number;
  course: CourseLabel;
  startsOn: CivilDate;
  endsOn: CivilDate;
  sourceName?: string;
  /**
   * Solo en memoria, nunca en GitHub: indica que las fechas oficiales de este
   * curso son una estimación a partir del curso anterior.
   */
  estimatedFrom?: CourseLabel;
  entries: CalendarEntry[];
}

// ---------------------------------------------------------------------------
// Traslado de saldo entre cursos
// ---------------------------------------------------------------------------

/** cursos/AAAA-AA/traslado.json (opcional) */
export interface CarryoverFile {
  schemaVersion: number;
  /** Curso que recibe el saldo. */
  course: CourseLabel;
  fromCourse: CourseLabel;
  /** Horas trasladadas (positivas = exceso; negativas = déficit). */
  hours: number;
  /** Saldo final del curso de origen en el momento del traslado. */
  sourceBalanceAtTransfer: number;
  createdAt: UtcDateTime;
  updatedAt: UtcDateTime;
  note?: string;
}
