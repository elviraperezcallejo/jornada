import type { CarryoverFile, CourseLabel } from "../domain/types";
import { validateCarryoverFile } from "../domain/validate";
import { carryoverPath } from "./paths";
import type { DataRepository } from "./repository";

/**
 * Traslado de saldo entre cursos (cursos/AAAA-AA/traslado.json).
 * Es una acción ocasional (una vez al año), así que necesita conexión: no
 * pasa por la cola local.
 */
export async function readCarryover(repo: DataRepository, course: CourseLabel): Promise<CarryoverFile | null> {
  return (await repo.read<CarryoverFile>(carryoverPath(course), validateCarryoverFile))?.data ?? null;
}

export async function saveCarryover(repo: DataRepository, file: CarryoverFile): Promise<CarryoverFile> {
  const saved = await repo.update<CarryoverFile>(
    carryoverPath(file.course),
    validateCarryoverFile,
    (cur) => (cur ? { ...file, createdAt: cur.createdAt } : file),
    `Traslado de saldo ${file.fromCourse} → ${file.course}: ${file.hours} h`,
  );
  return saved.data;
}
