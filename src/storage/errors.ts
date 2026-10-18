/** Errores tipados para que la interfaz pueda explicar qué pasa. */

export class StorageError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = new.target.name;
  }
}

/** 401: token inválido, revocado o caducado. */
export class AuthError extends StorageError {}

/** 403: sin permiso o límite de peticiones alcanzado. */
export class ForbiddenError extends StorageError {}

/**
 * El fichero cambió en GitHub desde que se leyó (otro dispositivo escribió
 * antes). La documentación indica 409 para este endpoint; 422 también se
 * trata como posible conflicto porque no puedo asegurar qué código exacto
 * devuelve GitHub ante un SHA desactualizado.
 */
export class ConflictError extends StorageError {}

/** Sin conexión o error de red. */
export class NetworkError extends StorageError {}

/** Los datos no superan la validación: no se escriben. */
export class InvalidDataError extends StorageError {
  constructor(readonly path: string, readonly errors: string[]) {
    super(`Datos no válidos en ${path}:\n- ${errors.join("\n- ")}`);
  }
}

/** El repositorio de datos es público: se rechaza para no exponer datos. */
export class PublicRepoError extends StorageError {}
