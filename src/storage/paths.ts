import type { CourseLabel, YearMonth } from "../domain/types";
import { isCourseLabel, isYearMonth } from "../domain/time";

/** Rutas dentro del repositorio privado de datos. */
export const CONFIG_PATH = "config.json";

export function sessionsPath(month: YearMonth): string {
  if (!isYearMonth(month)) throw new Error(`Mes no válido: ${month}`);
  return `fichajes/${month}.json`;
}

export function calendarPath(course: CourseLabel): string {
  if (!isCourseLabel(course)) throw new Error(`Curso no válido: ${course}`);
  return `cursos/${course}/calendario.json`;
}

export function carryoverPath(course: CourseLabel): string {
  if (!isCourseLabel(course)) throw new Error(`Curso no válido: ${course}`);
  return `cursos/${course}/traslado.json`;
}
