import { DateTime } from "luxon";
import { daySummary } from "../../domain/compute";
import { describeError, sessionsTouchingDay } from "../../domain/sessions";
import { madridDateOf, nowUtc } from "../../domain/time";
import { TIMEZONE, type WorkSession } from "../../domain/types";
import type { App } from "../app";
import { confirmDanger, dialog, h, toast } from "../dom";
import { dateLong, dateShort, dateTimeShort, formatHours, fromInputValue, time, toInputValue } from "../format";

let selected: string | null = null;

const ORIGIN: Record<WorkSession["origin"], string> = { boton: "Botón", manual: "Añadido a mano", offline: "Sin conexión" };

export function historialView(app: App): HTMLElement {
  const today = app.today();
  const day = selected ?? today;
  const now = nowUtc();
  const all = app.sessions.all();
  const list = sessionsTouchingDay(all, day, now);
  const summary = daySummary(day, app.ctx());
  const pending = app.sessions.liveSessions().filter((s) => s.end === null && madridDateOf(s.start) < today);
  const go = (d: string) => { selected = d; app.render(); };
  const shift = (n: number) => go(DateTime.fromISO(day, { zone: TIMEZONE }).plus({ days: n }).toISODate()!);

  return h("section", { class: "view", "aria-labelledby": "t-hist" },
    h("h1", { id: "t-hist" }, "Historial"),
    pending.length
      ? h("div", { class: "note note-warn" },
          h("p", {}, "Fichajes sin salida. No cuentan hasta que indiques cuándo saliste:"),
          h("ul", {}, pending.map((s) => h("li", {},
            h("button", { type: "button", class: "link", onclick: () => go(madridDateOf(s.start)) }, `Entrada del ${dateTimeShort(s.start)}`)))),
        )
      : null,
    h("div", { class: "pager" },
      h("button", { type: "button", class: "btn", onclick: () => shift(-1), "aria-label": "Día anterior" }, "‹"),
      h("input", { type: "date", value: day, max: today, "aria-label": "Día", onchange: (e: Event) => go((e.target as HTMLInputElement).value || today) }),
      h("button", { type: "button", class: "btn", onclick: () => shift(1), disabled: day >= today, "aria-label": "Día siguiente" }, "›"),
      day !== today ? h("button", { type: "button", class: "btn", onclick: () => go(today) }, "Hoy") : null,
    ),
    h("h2", {}, dateLong(day)),
    h("p", { class: "muted" }, `${formatHours(summary.workedHours)} trabajadas de ${formatHours(summary.referenceHours)} de referencia.`),
    list.length
      ? h("ul", { class: "sessions" }, list.map((s) => sessionItem(app, s, day)))
      : h("p", { class: "empty" }, "No hay fichajes este día."),
    h("button", { type: "button", class: "btn btn-primary", onclick: () => editDialog(app, null, day) }, "Añadir fichaje"),
  );
}

function sessionItem(app: App, s: WorkSession, day: string) {
  const start = madridDateOf(s.start) === day ? time(s.start) : dateTimeShort(s.start);
  const end = s.end === null ? "sin salida" : madridDateOf(s.end) === day ? time(s.end) : dateTimeShort(s.end);
  const hours = s.end ? (Date.parse(s.end) - Date.parse(s.start)) / 3_600_000 : null;
  return h("li", { class: `session ${s.end ? "" : "open"}` },
    h("div", { class: "session-main" },
      h("strong", {}, `${start} – ${end}`),
      hours !== null ? h("span", { class: "muted" }, formatHours(hours)) : null,
    ),
    h("div", { class: "muted small" }, ORIGIN[s.origin], s.note ? `. ${s.note}` : ""),
    h("div", { class: "row-actions" },
      h("button", { type: "button", class: "btn", onclick: () => editDialog(app, s, day) }, "Corregir"),
      h("button", {
        type: "button", class: "btn btn-danger-quiet",
        onclick: async () => {
          if (!(await confirmDanger("Eliminar fichaje", `Se eliminará el fichaje ${start} – ${end} del ${dateShort(day)}.`, "Eliminar"))) return;
          const r = await app.sessions.remove(s.id);
          if (!r.ok) return void toast(describeError(r.error), "error");
          app.afterAction(r.sync);
          toast("Fichaje eliminado.");
        },
      }, "Eliminar"),
    ),
  );
}

async function editDialog(app: App, s: WorkSession | null, day: string) {
  const defStart = s?.start ?? DateTime.fromISO(`${day}T08:00`, { zone: TIMEZONE }).toUTC().toISO()!;
  const defEnd = s ? s.end : DateTime.fromISO(`${day}T15:30`, { zone: TIMEZONE }).toUTC().toISO()!;
  const start = h("input", { type: "datetime-local", id: "f-start", value: toInputValue(defStart), required: true });
  const end = h("input", { type: "datetime-local", id: "f-end", value: defEnd ? toInputValue(defEnd) : "" });
  const note = h("input", { type: "text", id: "f-note", value: s?.note ?? "", maxlength: 200 });
  const choice = await dialog(s ? "Corregir fichaje" : "Añadir fichaje", [
    h("label", { for: "f-start" }, "Entrada"), start,
    h("label", { for: "f-end" }, "Salida (vacío si sigue abierto)"), end,
    h("label", { for: "f-note" }, "Nota (opcional)"), note,
  ], [
    { label: "Cancelar", value: "no" },
    { label: s ? "Guardar cambios" : "Añadir fichaje", value: "si", kind: "primary" },
  ]);
  if (choice !== "si") return;
  const st = fromInputValue(start.value);
  const en = end.value ? fromInputValue(end.value) : null;
  if (!st || (end.value && !en)) return void toast("Revisa las horas.", "error");
  const input = { start: st, end: en, note: note.value };
  const r = s ? await app.sessions.edit(s.id, input) : await app.sessions.add(input);
  if (!r.ok) return void toast(describeError(r.error), "error");
  app.afterAction(r.sync);
  toast(s ? "Fichaje corregido." : "Fichaje añadido.");
}
