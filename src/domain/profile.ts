import { courseBounds } from "./time";
import type { Category, ConfigFile, CourseLabel, Profile } from "./types";

/**
 * Textos según el perfil. Las categorías internas no cambian (los datos de
 * un perfil sirven en el otro); solo cambia cómo se llaman en pantalla.
 */
export const profileOf = (c: ConfigFile): Profile => c.profile ?? "uva";

const UVA: Record<Category, string> = {
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

const GENERIC: Record<Category, string> = {
  ...UVA,
  uva_no_lectivo: "Cierre o día no laborable de la empresa",
  centro: "Fiesta del centro de trabajo",
  periodo_vacacional: "Periodo de cierre o vacacional",
  academico: "Fecha de referencia",
};

export function categoryLabel(cat: Category, profile: Profile): string {
  return (profile === "uva" ? UVA : GENERIC)[cat];
}

/** "curso 2026-27" (UVa) o "septiembre de 2026 a agosto de 2027" (otros). */
export function periodLabel(course: CourseLabel, profile: Profile): string {
  if (profile === "uva") return `curso ${course}`;
  const { startsOn, endsOn } = courseBounds(course);
  return `periodo de septiembre de ${startsOn.slice(0, 4)} a agosto de ${endsOn.slice(0, 4)}`;
}

/** Plantilla para pegar en "Importar calendario" (probada con el lector genérico). */
export const GENERIC_TEMPLATE = `Calendario laboral 2027
Festivos nacionales y autonómicos:
1 de enero: Año Nuevo
6 de enero: Epifanía del Señor
1 de mayo: Fiesta del Trabajo
12 de octubre: Fiesta Nacional
Fiestas locales:
15 de mayo: Fiesta local
Cierres de la empresa:
Puente: 7 de diciembre
Navidad: del 24 de diciembre al 31 de diciembre`;

/** Segunda plantilla: tabla con mes y año, días y motivo (formato habitual en calendarios escolares). */
export const TABLE_TEMPLATE = `Mes Fechas Motivo
Octubre 2026 Lunes 12 Fiesta Nacional
Diciembre 2026 Lunes 7 y martes 8 Fiestas laborales
Diciembre 2026 Del jueves 24 al jueves 31 Cierre de Navidad
Mayo 2027 Sábado 15 Fiesta local`;
