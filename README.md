# Jornada UVa: control personal de horas

PWA para registrar la jornada y compararla con la del contrato. La aplicación
se publica en GitHub Pages (repositorio público) y los datos se guardan en un
**repositorio privado** del propio usuario mediante la API de GitHub.

## Estado: fases (a) a (e) completadas

### Fase (e): interfaz para móvil y escritorio

- `src/ui/`: pantallas Fichar, Historial, Resumen, Calendario, Ajustes y Cambios sin aplicar.
  Sin frameworks; todo el texto se inserta como texto (nunca HTML) para proteger el token.
- PWA instalable (`public/manifest.webmanifest`, `public/sw.js`): se abre sin conexión y los
  fichajes se guardan en el dispositivo hasta que vuelve la red.
- Política de seguridad de contenidos en la versión publicada: la página solo carga sus
  propios ficheros y solo se conecta con `api.github.com`.
- `.github/workflows/publicar.yml`: pruebas, compilación y publicación en GitHub Pages.

### Fase (d): cálculos y comparación con el contrato

- `src/domain/compute.ts`: horas por día (partiendo en cada medianoche de Madrid), semana ISO,
  mes, curso o año natural; referencia prorrateada, diferencia absoluta y relativa, horas en días
  no laborables, saldo del curso, traslado al curso siguiente y cupos de vacaciones y permisos.
- `src/domain/export.ts`: CSV de fichajes y de resúmenes, y copia completa en JSON.
- `src/storage/carryover.ts`: guardar y leer el traslado de saldo.
- `src/domain/estimate.ts`: si falta el calendario de un curso, se estima a partir del anterior
  (solo en memoria, marcado como estimado; nunca se guarda). Desactivable en Ajustes.
- Pruebas: `tests/compute.test.ts` incluye los casos del enunciado.

### Fase (c): calendario, importación y mapeo

- `src/import/pdfText.ts` y `loadPdfjs.ts`: lectura del PDF en el navegador con pdf.js (Apache-2.0).
- `src/import/parseUvaCalendar.ts`: lector del calendario académico UVa (festivos, no lectivos,
  fiestas locales del campus y fiesta del centro configurados, y fechas de inicio y fin de cuatrimestre).
  Acepta también texto pegado. Probado con el PDF oficial 2026-27 (`tests/fixtures`).
- `src/import/importFlow.ts`: la propuesta se guarda solo en el dispositivo hasta que el usuario confirma.
- `src/domain/calendar.ts`: laborabilidad de cada día, vacaciones y permisos, días de compensación,
  semanas afectadas por un cambio y edición del calendario.
- `src/storage/calendarStore.ts`: calendarios por curso, sincronizados como los fichajes.

### Fase (b): fichaje y almacenamiento

- `src/domain/sessions.ts`: lógica pura del botón Entrar/Salir, pendientes de revisión
  (salida olvidada o cruce de medianoche), doble toque, añadir, corregir y eliminar.
- `src/storage/sessionStore.ts`: "primero en local". Cada acción se guarda en el
  dispositivo y se envía a GitHub en cuanto hay conexión. Si otro dispositivo cambió
  lo mismo antes, no se pisa: queda como conflicto para revisarlo.
- `src/storage/local.ts`: almacenamiento del dispositivo (IndexedDB en el navegador).

### Fase (a): modelo de datos y conexión

- `src/domain/types.ts`: modelo de datos (fichajes, contrato, calendario por curso, traslado de saldo).
- `src/domain/validate.ts`: validación de cada fichero antes de leerlo y de escribirlo.
- `src/domain/time.ts`: fechas en Europe/Madrid y cursos de 1 sep a 31 ago.
- `src/domain/defaults.ts`: configuración por defecto y datos semilla 2026-27 (solo pruebas).
- `src/storage/`: cliente de la API de GitHub, credenciales locales, escritura con reintento ante conflictos y comprobación de conexión.

## Estructura del repositorio privado de datos

```
config.json                     contrato versionado (horas, días, cupos de vacaciones y permisos) y ajustes
fichajes/AAAA-MM.json           fichajes cuya entrada cae en ese mes (hora de Madrid)
cursos/AAAA-AA/calendario.json  fechas del curso con categoría, origen y "laboral sí/no"
cursos/AAAA-AA/traslado.json    saldo traído del curso anterior (opcional)
```

## Desarrollo

```bash
npm install
npm test           # pruebas unitarias
npm run typecheck  # comprobación de tipos
npm run dev        # versión de desarrollo en http://localhost:5173
```

`.npmrc` activa `legacy-peer-deps` porque, en el entorno de desarrollo, npm 10
falló al resolver dependencias opcionales de Vitest.

## Preparar los datos (una vez)

1. Crea en GitHub un repositorio **privado** vacío, por ejemplo `datos-jornada`.
2. Crea un token de grano fino: Settings → Developer settings → Personal access
   tokens → Fine-grained tokens.
   - Expiration: elige una fecha (es obligatoria) y apúntala; la app avisará antes de que caduque.
   - Repository access: *Only select repositories* → solo `datos-jornada`.
   - Permissions → Repository permissions → **Contents: Read and write**.
3. En la app (fase e), en Ajustes, introduce usuario, repositorio, token y fecha de caducidad.
   El token se guarda solo en ese navegador.

La app se niega a usar un repositorio de datos público.
