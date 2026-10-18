import { daySummary, weekSummary } from "../../domain/compute";
import { describeError, type ClockState } from "../../domain/sessions";
import { madridDateOf, nowUtc } from "../../domain/time";
import type { App } from "../app";
import { tone } from "../format";
import { dialog, h, toast } from "../dom";
import { dateLong, dateTimeShort, formatHours, formatRatio, fromInputValue, time, toInputValue } from "../format";

/** Pantalla principal: un botón para entrar y salir. */
export function ficharView(app: App): HTMLElement {
  const state = app.sessions.state();
  const ctx = app.ctx();
  const today = app.today();
  const day = daySummary(today, ctx);
  const week = weekSummary(today, ctx);

  const busy = { v: false };
  async function press(resolution?: "ahora" | string) {
    if (busy.v) return;
    busy.v = true;
    const r = await app.sessions.toggle({ offline: !navigator.onLine, resolution });
    busy.v = false;
    if (!r.ok) {
      if (r.error.code === "requiere_confirmacion") return void resolvePending(app, state);
      return void toast(describeError(r.error), "error");
    }
    navigator.vibrate?.(30);
    app.afterAction(r.sync);
  }

  const kind = state.kind;
  const label = kind === "sin_fichar" ? "Entrar" : kind === "fichado" ? "Salir" : "Resolver";
  const detail =
    kind === "fichado" ? `Dentro desde las ${time(state.open.start)}`
    : kind === "pendiente_revision" ? `Entrada abierta desde el ${dateTimeShort(state.open.start)}`
    : state.lastSession?.end
      ? madridDateOf(state.lastSession.end) === today ? `Última salida hoy a las ${time(state.lastSession.end)}` : `Última salida: ${dateTimeShort(state.lastSession.end)}`
    : "Sin fichajes todavía";

  const elapsed = kind === "fichado"
    ? formatHours((Date.parse(nowUtc()) - Date.parse(state.open.start)) / 3_600_000)
    : null;

  return h("section", { class: "view view-fichar", "aria-labelledby": "t-fichar" },
    h("h1", { id: "t-fichar", class: "today" }, dateLong(today)),
    h("div", { class: `clock clock-${kind}` },
      h("button", {
        type: "button", class: "punch", "aria-describedby": "punch-detail",
        onclick: () => (kind === "pendiente_revision" ? resolvePending(app, state) : press()),
      },
        h("span", { class: "punch-label" }, label),
        elapsed ? h("span", { class: "punch-elapsed" }, elapsed) : null,
      ),
      h("p", { id: "punch-detail", class: "punch-detail" }, detail),
    ),
    h("dl", { class: "ledger" },
      row("Hoy", day.workedHours, day.referenceToDate, day.diffHours, null, day.provisional),
      row("Esta semana", week.workedHours, week.referenceToDate, week.diffHours, week.diffRatio, week.provisional),
    ),
    week.pendingSessions.length || day.pendingSessions.length
      ? h("p", { class: "note note-warn" }, "Hay fichajes sin salida. Corrígelos en Historial para que cuenten.")
      : null,
    week.undecidedDates.length
      ? h("p", { class: "note" }, "Esta semana hay fechas del calendario sin decidir; de momento cuentan como laborables.")
      : null,
    week.estimatedCourses.length ? h("p", { class: "note" }, "La referencia usa un calendario estimado a partir del curso anterior.") : null,
  );
}

function row(name: string, worked: number, ref: number, diff: number, ratio: number | null, provisional: boolean) {
  return h("div", { class: "ledger-row" },
    h("dt", {}, name),
    h("dd", {},
      h("span", { class: "big" }, formatHours(worked)),
      h("span", { class: "of" }, ` de ${formatHours(ref)}`),
      h("span", { class: `diff ${tone(diff)}` },
        formatHours(diff, true), ratio !== null ? ` (${formatRatio(ratio)})` : ""),
      provisional ? h("span", { class: "tag" }, "en curso") : null,
    ),
  );
}

/** Entrada abierta desde otro día: ¿se sale ahora o se olvidó fichar? Nunca se inventa la hora. */
async function resolvePending(app: App, state: ClockState) {
  if (state.kind !== "pendiente_revision") return;
  const input = h("input", { type: "datetime-local", id: "exit-at", value: toInputValue(state.open.start) });
  const choice = await dialog(
    "Entrada sin salida",
    [
      h("p", {}, `La entrada del ${dateTimeShort(state.open.start)} sigue abierta. ¿Sales ahora o olvidaste fichar la salida?`),
      h("label", { for: "exit-at" }, "Hora real de salida (si la olvidaste)"),
      input,
    ],
    [
      { label: "Cancelar", value: "cancel" },
      { label: "Guardar esa hora", value: "hora" },
      { label: "Salgo ahora", value: "ahora", kind: "primary" },
    ],
  );
  if (!choice || choice === "cancel") return;
  const resolution = choice === "ahora" ? "ahora" : fromInputValue(input.value);
  if (!resolution) return void toast("Indica una hora de salida válida.", "error");
  const r = await app.sessions.toggle({ resolution });
  if (!r.ok) return void toast(describeError(r.error), "error");
  app.afterAction(r.sync);
}
