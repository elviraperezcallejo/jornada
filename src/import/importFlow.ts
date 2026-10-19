import { courseOf, isCourseLabel } from "../domain/time";
import type { CalendarEntry, ConfigFile, CourseLabel, UtcDateTime } from "../domain/types";
import type { ImportDraft } from "../storage/calendarStore";
import { parseGenericCalendar } from "./parseGenericCalendar";
import { parseUvaCalendar, proposalToEntries } from "./parseUvaCalendar";

/**
 * Pantalla "Importar calendario":
 * 1. el usuario sube el PDF (se lee con pdfToText) o pega el texto;
 * 2. buildDraft genera la propuesta y se guarda solo en el dispositivo;
 * 3. la pantalla de revisión muestra las fechas propuestas;
 * 4. al confirmar, se usa planConfirm con la decisión "laboral sí/no" de cada fecha.
 *
 * Primero se intenta el lector del calendario académico de la UVa (exacto,
 * para su formato). Si el texto no tiene ese formato, se usa el lector
 * genérico, que busca fechas con texto en cualquier documento. Así los
 * usuarios de la UVa conservan exactamente el comportamiento de siempre.
 * Si nada se reconoce, la app sigue funcionando: se puede pegar el texto o
 * introducir las fechas a mano.
 */
export type DraftResult = { ok: true; draft: ImportDraft } | { ok: false; message: string; warnings: string[] };

export function buildDraft(
  text: string,
  sourceName: string,
  config: ConfigFile,
  now: UtcDateTime,
  /** Fechas que ya tiene el calendario de un curso (para no proponerlas de nuevo). */
  existingFor: (course: CourseLabel) => CalendarEntry[] = () => [],
  /** Curso ("2026-27") o año natural ("2027") para las fechas sin año. */
  hint?: string,
): DraftResult {
  const uva = parseUvaCalendar(text, { ...config.calendarImport, courseHint: hint && isCourseLabel(hint) ? hint : undefined });
  if (uva.course && uva.items.length) {
    const entries = proposalToEntries(uva.items, `PDF: ${sourceName}`, now, existingFor(uva.course));
    const warnings = entries.length ? uva.warnings : [...uva.warnings, "Todas las fechas reconocidas ya estaban en el calendario de ese curso."];
    return {
      ok: true,
      draft: { course: uva.course, parser: "uva", label: uva.course, sourceName, items: uva.items, entries, warnings, createdAt: now },
    };
  }

  const gen = parseGenericCalendar(text, { hint: hint || uva.course || undefined });
  if (!gen.items.length) {
    const needsYear = gen.warnings.some((w) => w.includes("sin año"));
    return {
      ok: false,
      message: needsYear
        ? "No se ha podido saber a qué curso o año corresponden las fechas. Indícalo a mano."
        : "No se ha reconocido ninguna fecha en este formato. Puedes pegar el texto o introducir las fechas a mano.",
      warnings: gen.warnings,
    };
  }
  const courses = [...new Set(gen.items.flatMap((i) => [courseOf(i.from), courseOf(i.to ?? i.from)]))];
  const existing = courses.flatMap((c) => existingFor(c));
  const entries = proposalToEntries(gen.items, `Importado: ${sourceName}`, now, existing);
  const warnings = [
    "Este documento no tiene el formato del calendario de la UVa: se han buscado fechas de forma general. Revísalas con cuidado.",
    ...gen.warnings,
    ...(entries.length ? [] : ["Todas las fechas reconocidas ya estaban en el calendario."]),
  ];
  return {
    ok: true,
    draft: {
      course: courseOf(gen.items[0]!.from), parser: "generico", label: gen.period ?? courses.join(" y "),
      sourceName, items: gen.items, entries, warnings, createdAt: now,
    },
  };
}

/** Agrupa fechas por curso (sep–ago): cada curso se guarda en su propio fichero. */
export function groupByCourse<T extends { date: string }>(items: T[]): Map<CourseLabel, T[]> {
  const out = new Map<CourseLabel, T[]>();
  for (const it of items) {
    const c = courseOf(it.date);
    out.set(c, [...(out.get(c) ?? []), it]);
  }
  return out;
}
