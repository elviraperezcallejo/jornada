import type { CalendarEntry, ConfigFile, CourseLabel, UtcDateTime } from "../domain/types";
import type { ImportDraft } from "../storage/calendarStore";
import { parseUvaCalendar, proposalToEntries } from "./parseUvaCalendar";

/**
 * Pantalla "Importar calendario":
 * 1. el usuario sube el PDF (se lee con pdfToText) o pega el texto;
 * 2. buildDraft genera la propuesta y se guarda solo en el dispositivo;
 * 3. la vista mensual muestra draftEntries para revisar;
 * 4. al confirmar, se usa planConfirm con la decisión "laboral sí/no" de cada fecha.
 * Si el formato no se reconoce, la app sigue funcionando: se puede pegar el
 * texto o añadir las fechas a mano.
 */
export type DraftResult = { ok: true; draft: ImportDraft } | { ok: false; message: string; warnings: string[] };

export function buildDraft(
  text: string,
  sourceName: string,
  config: ConfigFile,
  now: UtcDateTime,
  /** Fechas que ya tiene el calendario de un curso (para no proponerlas de nuevo). */
  existingFor: (course: CourseLabel) => CalendarEntry[] = () => [],
  courseHint?: CourseLabel,
): DraftResult {
  const r = parseUvaCalendar(text, { ...config.calendarImport, courseHint });
  if (!r.course) return { ok: false, message: "No se ha podido saber a qué curso corresponde. Indícalo a mano.", warnings: r.warnings };
  if (!r.items.length) {
    return {
      ok: false,
      message: "No se ha reconocido ninguna fecha en este formato. Puedes pegar el texto o introducir las fechas a mano.",
      warnings: r.warnings,
    };
  }
  const entries = proposalToEntries(r.items, `PDF: ${sourceName}`, now, existingFor(r.course));
  const warnings = entries.length ? r.warnings : [...r.warnings, "Todas las fechas reconocidas ya estaban en el calendario de ese curso."];
  return { ok: true, draft: { course: r.course, sourceName, items: r.items, entries, warnings, createdAt: now } };
}
