import { DateTime } from "luxon";
import {
  applyCalendarOp,
  dayInfo,
  indexByDate,
  leaveCandidateDays,
  planAddEntries,
  planAddLeaveDays,
  planConfirm,
  planDeleteEntry,
  planEditEntry,
  type CalendarPlan,
} from "../../domain/calendar";
import { effectiveCalendars, weekChanges } from "../../domain/compute";
import { courseOf, nowUtc } from "../../domain/time";
import { CATEGORIES, TIMEZONE, type CalendarEntry, type Category, type CourseLabel, type LeaveCategory } from "../../domain/types";
import { buildDraft } from "../../import/importFlow";
import { loadPdfjs } from "../../import/loadPdfjs";
import { pdfToText } from "../../import/pdfText";
import type { ImportDraft } from "../../storage/calendarStore";
import type { App } from "../app";
import { confirmDanger, dialog, h, toast } from "../dom";
import { CATEGORY_LABEL, dateLong, dateShort, formatHours, monthName, plural, weekLabel } from "../format";

let month: string | null = null;
let selectedDay: string | null = null;
let draft: ImportDraft | null = null;
let draftLoaded = false;

export function calendarioView(app: App): HTMLElement {
  if (!draftLoaded) {
    draftLoaded = true;
    void app.calendars.loadDraft().then((d) => { draft = d ?? null; if (d) app.render(); });
  }
  if (draft) return reviewView(app, draft);

  const today = app.today();
  const ym = month ?? today.slice(0, 7);
  const first = DateTime.fromISO(`${ym}-01`, { zone: TIMEZONE });
  const ctx = app.ctx();
  const cals = effectiveCalendars(ctx, first.toISODate()!, first.endOf("month").toISODate()!);
  const idx = indexByDate(cals);
  const course = courseOf(first.toISODate()!);
  const estimated = !!cals[course]?.estimatedFrom;
  const go = (n: number) => { month = first.plus({ months: n }).toFormat("yyyy-MM"); selectedDay = null; app.render(); };

  const cells: HTMLElement[] = [];
  for (let i = 1; i < first.weekday; i++) cells.push(h("div", { class: "cell empty", "aria-hidden": "true" }));
  for (let d = first; d.month === first.month; d = d.plus({ days: 1 })) {
    const date = d.toISODate()!;
    const info = dayInfo(date, ctx.config, cals, idx);
    const cls = [
      "cell",
      info.leave ? "leave" : info.compensation ? "comp" : !info.contractWorkday ? "weekend" : info.isWorkday ? "work" : "off",
      info.undecided.length ? "undecided" : "",
      info.estimatedCalendar && (idx.get(date) ?? []).some((e) => e.id.startsWith("estimado:")) ? "estimated" : "",
      date === today ? "today" : "",
      date === selectedDay ? "selected" : "",
    ].join(" ");
    const desc = info.leave ? CATEGORY_LABEL[info.leave.category] : info.nonWorking[0]?.name ?? (info.isWorkday ? "laborable" : "no laborable");
    cells.push(h("button", {
      type: "button", class: cls, "aria-label": `${dateLong(date)}: ${desc}${info.undecided.length ? ", sin decidir" : ""}`,
      onclick: () => { selectedDay = date; app.render(); },
    }, String(d.day)));
  }

  return h("section", { class: "view", "aria-labelledby": "t-cal" },
    h("h1", { id: "t-cal" }, "Calendario"),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn btn-primary", onclick: () => importDialog(app) }, "Importar calendario"),
      h("button", { type: "button", class: "btn", onclick: () => leaveDialog(app) }, "Planificar vacaciones o permisos"),
    ),
    h("div", { class: "pager" },
      h("button", { type: "button", class: "btn", onclick: () => go(-1), "aria-label": "Mes anterior" }, "‹"),
      h("h2", { class: "pager-title" }, monthName(ym)),
      h("button", { type: "button", class: "btn", onclick: () => go(1), "aria-label": "Mes siguiente" }, "›"),
    ),
    estimated ? h("p", { class: "note" }, `El curso ${course} aún no tiene calendario: las fechas en cursiva son una estimación a partir de ${cals[course]!.estimatedFrom}.`) : null,
    !cals[course] ? h("p", { class: "note note-warn" }, `No hay calendario del curso ${course}. Impórtalo o añade las fechas a mano.`) : null,
    h("div", { class: "month", role: "grid" },
      ["L", "M", "X", "J", "V", "S", "D"].map((d) => h("div", { class: "dow", "aria-hidden": "true" }, d)),
      cells,
    ),
    h("ul", { class: "legend" },
      h("li", { class: "work" }, "Laborable"), h("li", { class: "off" }, "No laborable"),
      h("li", { class: "leave" }, "Vacaciones o permiso"), h("li", { class: "undecided" }, "Sin decidir"),
    ),
    selectedDay ? dayPanel(app, selectedDay) : h("p", { class: "muted" }, "Toca un día para ver o cambiar sus fechas."),
  );
}

function dayPanel(app: App, date: string) {
  const course = courseOf(date);
  const real = app.calendars.calendar(course);
  const ctx = app.ctx();
  const cals = effectiveCalendars(ctx, date, date);
  const entries = (cals[course]?.entries ?? []).filter((e) => e.date === date && !e.deleted);
  const info = dayInfo(date, ctx.config, cals);

  return h("section", { class: "block", "aria-labelledby": "t-day" },
    h("h2", { id: "t-day" }, dateLong(date)),
    h("p", { class: "muted" }, info.isWorkday ? "Laborable: cuenta con referencia de horas." : "Sin referencia de horas.",
      info.consumesLeave ? " Gasta un día de cupo." : ""),
    entries.length ? h("ul", { class: "entries" }, entries.map((e) => {
      const est = e.id.startsWith("estimado:");
      return h("li", { class: est ? "estimated" : "" },
        h("strong", {}, e.name ?? CATEGORY_LABEL[e.category]),
        h("span", { class: "muted small" }, ` ${CATEGORY_LABEL[e.category]}${e.isTransfer ? " (traslado)" : ""}. ${e.origin}.`),
        h("div", { class: "muted small" }, e.status === "propuesta" || e.isWorkingDay === null ? "Sin decidir" : e.isWorkingDay ? "Laborable" : "No laborable"),
        est || !real ? null : h("div", { class: "row-actions" },
          !["vacaciones_contrato", "permiso_personal", "compensacion"].includes(e.category)
            ? [
                h("button", { type: "button", class: "btn", onclick: () => save(app, planEditEntry(real, e.id, { isWorkingDay: false, status: "confirmada" }, nowUtc())) }, "No laborable"),
                h("button", { type: "button", class: "btn", onclick: () => save(app, planEditEntry(real, e.id, { isWorkingDay: true, status: "confirmada" }, nowUtc())) }, "Laborable"),
              ]
            : null,
          h("button", { type: "button", class: "btn btn-danger-quiet", onclick: async () => {
            if (!(await confirmDanger("Eliminar fecha", `Se eliminará «${e.name ?? CATEGORY_LABEL[e.category]}» del ${dateShort(date)}.`, "Eliminar"))) return;
            void save(app, planDeleteEntry(real, e.id, nowUtc()));
          } }, "Eliminar"),
          e.groupId ? h("button", { type: "button", class: "btn btn-danger-quiet", onclick: async () => {
            const n = real.entries.filter((x) => x.groupId === e.groupId && !x.deleted).length;
            if (!(await confirmDanger("Eliminar periodo", `Se eliminarán los ${n} días de «${e.name ?? CATEGORY_LABEL[e.category]}».`, "Eliminar periodo"))) return;
            void save(app, planDeleteEntry(real, e.id, nowUtc(), true));
          } }, "Eliminar todo el periodo") : null,
        ),
      );
    })) : h("p", { class: "empty" }, "No hay fechas especiales este día."),
    h("button", { type: "button", class: "btn", onclick: () => addDialog(app, date) }, "Añadir fecha aquí"),
  );
}

/** Muestra qué semanas cambian (con horas) y guarda si el usuario confirma. */
async function save(app: App, plan: CalendarPlan, askPreview = true): Promise<boolean> {
  if (!plan.ok) { toast(plan.errors.join(" "), "error"); return false; }
  const ctx = app.ctx();
  const preview = app.calendars.preview(plan, ctx.config);
  const sessionsExist = ctx.sessions.length > 0;
  if (askPreview && preview && preview.weeks.length && sessionsExist) {
    const after = { ...ctx.calendars };
    const cur = app.calendars.calendar(plan.op.course);
    after[plan.op.course] = applyCalendarOp(cur, plan.op);
    // Solo se avisa de semanas ya empezadas (las futuras aún no tienen nada calculado).
    const today = app.today();
    const changes = weekChanges(preview.weeks.filter((m) => m <= today), ctx, after).filter((w) => w.referenceBefore !== w.referenceAfter);
    if (changes.length) {
    const ok = await dialog("Este cambio afecta a semanas con fichajes", h("ul", {}, changes.map((w) => h("li", {},
      `${weekLabel(w.monday)}: referencia de ${formatHours(w.referenceBefore)} a ${formatHours(w.referenceAfter)}; diferencia de ${formatHours(w.diffBefore, true)} a ${formatHours(w.diffAfter, true)}.`))),
      [{ label: "Cancelar", value: "no" }, { label: "Guardar", value: "si", kind: "primary" }]);
    if (ok !== "si") return false;
    }
  }
  const r = await app.calendars.apply(plan);
  if (!r.ok) { toast(r.errors.join(" "), "error"); return false; }
  app.afterAction(r.sync);
  return true;
}

async function addDialog(app: App, date: string) {
  const cats = CATEGORIES.filter((c) => c !== "academico");
  const cat = h("select", { id: "a-cat" }, cats.map((c) => h("option", { value: c }, CATEGORY_LABEL[c])));
  const name = h("input", { type: "text", id: "a-name", maxlength: 120 });
  const to = h("input", { type: "date", id: "a-to", value: date, min: date });
  const lab = h("select", { id: "a-lab" }, h("option", { value: "no" }, "No laborable"), h("option", { value: "si" }, "Laborable"));
  const ok = await dialog(`Añadir fecha desde el ${dateShort(date)}`, [
    h("label", { for: "a-cat" }, "Tipo"), cat,
    h("label", { for: "a-name" }, "Nombre (opcional)"), name,
    h("label", { for: "a-to" }, "Hasta (para un periodo)"), to,
    h("label", { for: "a-lab" }, "¿Es laborable para ti?"), lab,
    h("p", { class: "muted small" }, "Vacaciones y permisos siempre son no laborables; un día de compensación mantiene sus horas de referencia."),
  ], [{ label: "Cancelar", value: "no" }, { label: "Añadir", value: "si", kind: "primary" }]);
  if (ok !== "si") return;
  const course = courseOf(date);
  if (courseOf(to.value || date) !== course) return void toast("El periodo cruza de un curso a otro: divídelo en dos.", "error");
  const plan = planAddEntries(app.calendars.calendar(course), course, {
    from: date, to: to.value || date, category: cat.value as Category, name: name.value, isWorkingDay: lab.value === "si",
  }, nowUtc());
  if (await save(app, plan)) toast("Fecha añadida.");
}

async function leaveDialog(app: App) {
  const today = app.today();
  const y = Number(today.slice(0, 4));
  const augYear = Number(today.slice(5, 7)) > 8 ? y + 1 : y;
  const cat = h("select", { id: "l-cat" }, h("option", { value: "vacaciones_contrato" }, "Vacaciones"), h("option", { value: "permiso_personal" }, "Permiso personal"));
  const from = h("input", { type: "date", id: "l-from", value: `${augYear}-08-01` });
  const to = h("input", { type: "date", id: "l-to", value: `${augYear}-08-31` });
  const ok = await dialog("Planificar vacaciones o permisos", [
    h("label", { for: "l-cat" }, "Tipo"), cat,
    h("label", { for: "l-from" }, "Desde"), from,
    h("label", { for: "l-to" }, "Hasta"), to,
    h("p", { class: "muted small" }, "Se proponen solo los días laborables del rango; podrás quitar los que no quieras."),
  ], [{ label: "Cancelar", value: "no" }, { label: "Calcular días", value: "si", kind: "primary" }]);
  if (ok !== "si" || !from.value || !to.value || to.value < from.value) return;
  const ctx = app.ctx();
  const days = leaveCandidateDays(from.value, to.value, ctx.config, ctx.calendars);
  if (!days.length) return void toast("No hay días laborables en ese rango.", "error");
  const boxes = days.map((d) => h("input", { type: "checkbox", checked: true, value: d, id: `d-${d}` }));
  const pick = await dialog(`${plural(days.length, "día laborable", "días laborables")}`, h("ul", { class: "checklist" },
    days.map((d, i) => h("li", {}, boxes[i]!, h("label", { for: `d-${d}` }, dateLong(d))))),
    [{ label: "Cancelar", value: "no" }, { label: "Guardar", value: "si", kind: "primary" }]);
  if (pick !== "si") return;
  const chosen = boxes.filter((b) => b.checked).map((b) => b.value);
  const byCourse = new Map<CourseLabel, string[]>();
  for (const d of chosen) byCourse.set(courseOf(d), [...(byCourse.get(courseOf(d)) ?? []), d]);
  for (const [course, ds] of byCourse) {
    const plan = planAddLeaveDays(app.calendars.calendar(course), course, ds, cat.value as LeaveCategory, nowUtc());
    if (!(await save(app, plan))) return;
  }
  toast(`${plural(chosen.length, "día guardado", "días guardados")}.`);
}

// ---------------------------------------------------------------------------
// Importación
// ---------------------------------------------------------------------------

async function importDialog(app: App) {
  const file = h("input", { type: "file", id: "i-file", accept: "application/pdf,.pdf" });
  const text = h("textarea", { id: "i-text", rows: 6, placeholder: "O pega aquí el texto del calendario" });
  const course = h("input", { type: "text", id: "i-course", placeholder: "Ej.: 2026-27", pattern: "\\d{4}-\\d{2}" });
  const ok = await dialog("Importar calendario académico", [
    h("p", { class: "muted small" }, "El PDF se lee en este dispositivo; no se envía a ningún sitio. Nada se guarda hasta que lo revises y confirmes."),
    h("label", { for: "i-file" }, "PDF del calendario"), file,
    h("label", { for: "i-text" }, "Texto (si el PDF no se reconoce)"), text,
    h("label", { for: "i-course" }, "Curso (solo si el texto no lo indica)"), course,
  ], [{ label: "Cancelar", value: "no" }, { label: "Leer fechas", value: "si", kind: "primary" }]);
  if (ok !== "si") return;
  try {
    let content = text.value;
    let name = "texto pegado";
    const f = file.files?.[0];
    if (f) {
      toast("Leyendo el PDF…");
      content = await pdfToText(await loadPdfjs(), new Uint8Array(await f.arrayBuffer()));
      name = f.name;
    }
    if (!content.trim()) return void toast("Elige un PDF o pega el texto.", "error");
    const r = buildDraft(content, name, app.config.get(), nowUtc(), (c) => app.calendars.calendar(c)?.entries ?? [], course.value || undefined);
    if (!r.ok) return void toast([r.message, ...r.warnings].join(" "), "error");
    draft = r.draft;
    await app.calendars.saveDraft(r.draft);
    app.render();
  } catch (e) {
    toast(`No se pudo leer el PDF (${(e as Error).message}). Prueba a pegar el texto.`, "error");
  }
}

/** Revisión de la propuesta: una fila por fecha o periodo, con la decisión «laboral sí/no». */
function reviewView(app: App, d: ImportDraft): HTMLElement {
  const rows = new Map<string, CalendarEntry[]>();
  for (const e of d.entries) rows.set(e.groupId ?? e.id, [...(rows.get(e.groupId ?? e.id) ?? []), e]);
  const decisions = new Map<string, "no" | "si" | "omitir">();
  for (const [k, es] of rows) decisions.set(k, es[0]!.category === "academico" ? "omitir" : "no");

  const byCat = new Map<Category, [string, CalendarEntry[]][]>();
  for (const [k, es] of rows) byCat.set(es[0]!.category, [...(byCat.get(es[0]!.category) ?? []), [k, es]]);

  const radios = (k: string) => {
    const nameAttr = `r-${k}`;
    return h("div", { class: "choice", role: "radiogroup", "aria-label": "Decisión" },
      (["no", "si", "omitir"] as const).map((v) => h("label", {},
        h("input", { type: "radio", name: nameAttr, value: v, checked: decisions.get(k) === v, onchange: () => decisions.set(k, v) }),
        { no: "No laborable", si: "Laborable", omitir: "No guardar" }[v])));
  };

  return h("section", { class: "view", "aria-labelledby": "t-rev" },
    h("h1", { id: "t-rev" }, `Revisar calendario ${d.course}`),
    h("p", { class: "muted" }, `Origen: ${d.sourceName}. Decide para cada fecha si es laborable para ti. Las fechas académicas son solo de referencia.`),
    d.warnings.map((w) => h("p", { class: "note note-warn" }, w)),
    [...byCat.entries()].map(([cat, list]) => h("section", { class: "block" },
      h("h2", {}, CATEGORY_LABEL[cat]),
      h("ul", { class: "review" }, list.map(([k, es]) => {
        const item = d.items.find((i) => i.name === es[0]!.name && i.from === es[0]!.date);
        const when = es.length > 1 ? `${dateShort(es[0]!.date)} – ${dateShort(es.at(-1)!.date)} (${es.length} días)` : dateLong(es[0]!.date);
        return h("li", {},
          h("strong", {}, es[0]!.name ?? CATEGORY_LABEL[cat]), h("span", {}, ` ${when}${es[0]!.isTransfer ? ", traslado" : ""}`),
          item ? h("div", { class: "muted small source" }, `«${item.sourceLine}»`) : null,
          radios(k));
      })),
    )),
    h("div", { class: "actions sticky" },
      h("button", { type: "button", class: "btn", onclick: async () => {
        if (!(await confirmDanger("Descartar importación", "Se descartará la propuesta sin guardar nada.", "Descartar"))) return;
        draft = null; await app.calendars.clearDraft(); app.render();
      } }, "Descartar"),
      h("button", { type: "button", class: "btn btn-primary", onclick: async () => {
        const chosen = [...rows.entries()].filter(([k]) => decisions.get(k) !== "omitir")
          .flatMap(([k, es]) => es.map((entry) => ({ entry, isWorkingDay: decisions.get(k) === "si" })));
        if (!chosen.length) return void toast("No hay fechas para guardar.", "error");
        const plan = planConfirm(app.calendars.calendar(d.course), d.course, chosen, nowUtc(), `Importar calendario ${d.course}`, d.sourceName);
        if (!(await save(app, plan))) return;
        draft = null; await app.calendars.clearDraft();
        toast(`${plural(chosen.length, "fecha guardada", "fechas guardadas")}.`);
        app.render();
      } }, "Guardar fechas"),
    ),
  );
}
