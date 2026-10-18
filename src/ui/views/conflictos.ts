import type { App } from "../app";
import { h } from "../dom";
import { dateTimeShort, dateShort } from "../format";

/** Cambios que no se aplicaron porque otro dispositivo cambió lo mismo antes. */
export function conflictosView(app: App): HTMLElement {
  const s = app.sessions.getConflicts();
  const c = app.calendars.getConflicts();
  const fmt = (start: string, end: string | null) => `${dateTimeShort(start)} – ${end ? dateTimeShort(end) : "sin salida"}`;
  return h("section", { class: "view", "aria-labelledby": "t-conf" },
    h("h1", { id: "t-conf" }, "Cambios sin aplicar"),
    !s.length && !c.length ? h("p", { class: "empty" }, "No hay nada pendiente de revisar.") : null,
    s.length ? h("ul", { class: "sessions" }, s.map((x) => h("li", { class: "session" },
      h("p", {}, x.reason),
      h("p", {}, h("strong", {}, "Tu cambio: "), x.op.session.deleted ? "eliminar el fichaje" : fmt(x.op.session.start, x.op.session.end)),
      h("p", {}, h("strong", {}, "En GitHub: "), x.remote ? (x.remote.deleted ? "eliminado" : fmt(x.remote.start, x.remote.end)) : "no existe"),
      h("p", { class: "muted small" }, "Si tu cambio era el correcto, vuelve a hacerlo desde Historial."),
      h("button", { type: "button", class: "btn", onclick: async () => { await app.sessions.dismissConflict(x.op.opId); app.render(); } }, "Entendido, quitar de la lista"),
    ))) : null,
    c.length ? h("ul", { class: "sessions" }, c.map((x) => h("li", { class: "session" },
      h("p", {}, x.reason),
      h("p", {}, `Cambio de calendario: ${x.op.label} (${x.op.entries.length} fecha(s), desde el ${dateShort(x.op.entries[0]?.date ?? "")}).`),
      h("p", { class: "muted small" }, "Revisa el calendario y, si hace falta, repite el cambio."),
      h("button", { type: "button", class: "btn", onclick: async () => { await app.calendars.dismissConflict(x.op.opId); app.render(); } }, "Entendido, quitar de la lista"),
    ))) : null,
  );
}
