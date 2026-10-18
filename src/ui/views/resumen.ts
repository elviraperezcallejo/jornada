import { DateTime } from "luxon";
import {
  annualSummary,
  buildCarryover,
  carryoverDrift,
  courseBalance,
  daySummary,
  leaveUsage,
  monthSummary,
  monthsOf,
  weekSummary,
  weeksOf,
  type PeriodSummary,
} from "../../domain/compute";
import { summaryCsv } from "../../domain/export";
import { annualBounds, annualKeyOf, isCourseLabel, nowUtc, shiftAnnualKey } from "../../domain/time";
import { TIMEZONE, type AnnualView, type CourseLabel } from "../../domain/types";
import { saveCarryover } from "../../storage/carryover";
import type { App } from "../app";
import { dialog, download, h, toast } from "../dom";
import { tone } from "../format";
import { dateLong, dateShort, formatHours, formatHoursShort, formatRatio, monthName, plural, weekLabel } from "../format";

type Scale = "dia" | "semana" | "mes" | "anio";
let scale: Scale = "semana";
let anchor: string | null = null; // fecha de referencia
let annualKey: string | null = null;

export function resumenView(app: App): HTMLElement {
  const today = app.today();
  const ctx = app.ctx();
  const view: AnnualView = ctx.config.annualView;
  const date = anchor ?? today;
  const key = annualKey && (view === "curso") === isCourseLabel(annualKey) ? annualKey : annualKeyOf(date, view);

  let title = "";
  let s: PeriodSummary;
  let breakdown: { label: string; summary: PeriodSummary }[] = [];
  if (scale === "dia") {
    s = daySummary(date, ctx);
    title = dateLong(date);
  } else if (scale === "semana") {
    s = weekSummary(date, ctx);
    title = weekLabel(s.from);
    breakdown = s.days.map((d) => ({ label: dateLong(d.date), summary: daySummary(d.date, ctx) }));
  } else if (scale === "mes") {
    s = monthSummary(date.slice(0, 7), ctx);
    title = monthName(date.slice(0, 7));
    breakdown = weeksOf(s).map((w) => ({ label: weekLabel(w.monday), summary: w.summary }));
  } else {
    s = annualSummary(key, ctx);
    title = view === "curso" ? `Curso ${key}` : `Año ${key}`;
    breakdown = monthsOf(s).map((m) => ({ label: monthName(m.month), summary: m.summary }));
  }

  const move = (n: number) => {
    if (scale === "anio") annualKey = shiftAnnualKey(key, n);
    else {
      const unit = scale === "dia" ? { days: n } : scale === "semana" ? { weeks: n } : { months: n };
      anchor = DateTime.fromISO(date, { zone: TIMEZONE }).plus(unit).toISODate()!;
    }
    app.render();
  };

  return h("section", { class: "view", "aria-labelledby": "t-res" },
    h("h1", { id: "t-res" }, "Resumen"),
    h("div", { class: "segmented", role: "group", "aria-label": "Periodo" },
      (["dia", "semana", "mes", "anio"] as Scale[]).map((sc) => h("button", {
        type: "button", "aria-pressed": String(scale === sc),
        onclick: () => { scale = sc; app.render(); },
      }, { dia: "Día", semana: "Semana", mes: "Mes", anio: "Año" }[sc])),
    ),
    scale === "anio"
      ? h("div", { class: "segmented small", role: "group", "aria-label": "Tipo de año" },
          (["curso", "anio_natural"] as AnnualView[]).map((v) => h("button", {
            type: "button", "aria-pressed": String(view === v),
            onclick: async () => {
              annualKey = null;
              const errs = await app.config.change((c) => ({ ...c, annualView: v }));
              if (errs.length) toast(errs.join(" "), "error");
              void app.syncNow();
              app.render();
            },
          }, v === "curso" ? "Curso (sep–ago)" : "Año natural")),
        )
      : null,
    h("div", { class: "pager" },
      h("button", { type: "button", class: "btn", onclick: () => move(-1), "aria-label": "Anterior" }, "‹"),
      h("h2", { class: "pager-title" }, title),
      h("button", { type: "button", class: "btn", onclick: () => move(1), "aria-label": "Siguiente" }, "›"),
      h("button", { type: "button", class: "btn", onclick: () => { anchor = null; annualKey = null; app.render(); } }, "Hoy"),
    ),
    metrics(s),
    warnings(s),
    breakdown.length > 1
      ? h("table", { class: "breakdown" },
          h("caption", { class: "muted small" }, "Horas y minutos (h:mm)."),
          h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Periodo"), h("th", { scope: "col" }, "Trabajadas"),
            h("th", { scope: "col" }, "Referencia"), h("th", { scope: "col" }, "Diferencia"))),
          h("tbody", {}, breakdown.map((b) => h("tr", {},
            h("th", { scope: "row" }, b.label),
            h("td", {}, formatHoursShort(b.summary.workedHours)),
            h("td", {}, formatHoursShort(b.summary.referenceToDate)),
            h("td", { class: tone(b.summary.diffHours) }, formatHoursShort(b.summary.diffHours, true)),
          ))),
        )
      : null,
    h("button", {
      type: "button", class: "btn",
      onclick: () => download(`jornada-${s.from}_${s.to}.csv`,
        summaryCsv(breakdown.length ? breakdown : [{ label: title, summary: s }], ctx.config.export), "text/csv;charset=utf-8"),
    }, "Descargar este resumen (CSV)"),
    scale === "anio" ? leaveSection(app, key, view) : null,
    scale === "anio" && view === "curso" ? balanceSection(app, key) : null,
  );
}

function metrics(s: PeriodSummary) {
  const partial = s.referenceToDate !== s.referenceHours;
  return h("dl", { class: "metrics" },
    item("Trabajadas", formatHours(s.workedHours), s.provisional ? "incluye el fichaje en curso" : null),
    item("Referencia", formatHours(s.referenceToDate), partial ? `hasta hoy; ${formatHours(s.referenceHours)} en todo el periodo` : plural(s.workdays, "día laborable", "días laborables")),
    item("Diferencia", formatHours(s.diffHours, true), formatRatio(s.diffRatio), tone(s.diffHours)),
    item("En días no laborables", formatHours(s.workedOnNonWorkdays), "ya incluidas en trabajadas"),
  );
}

function item(label: string, value: string, sub: string | null, cls = "") {
  return h("div", { class: "metric" }, h("dt", {}, label), h("dd", { class: cls }, value), sub ? h("dd", { class: "sub" }, sub) : null);
}

function warnings(s: PeriodSummary) {
  const out: HTMLElement[] = [];
  const firstCounted = s.days.find((d) => !d.beforeTracking);
  if (s.days.some((d) => d.beforeTracking)) {
    out.push(h("p", { class: "note" }, firstCounted
      ? `Cuenta desde el ${dateShort(firstCounted.date)}, el primer día registrado. Puedes cambiarlo en Ajustes.`
      : "Este periodo es anterior al primer día registrado: no cuenta."));
  }
  if (s.pendingSessions.length) out.push(h("p", { class: "note note-warn" }, `${s.pendingSessions.length} fichaje(s) sin salida no cuentan hasta corregirlos en Historial.`));
  if (s.undecidedDates.length) out.push(h("p", { class: "note" }, `${s.undecidedDates.length} fecha(s) del calendario sin decidir; cuentan como laborables hasta que decidas.`));
  if (s.estimatedCourses.length) out.push(h("p", { class: "note" }, `Calendario estimado para ${s.estimatedCourses.join(", ")} a partir del curso anterior.`));
  if (s.missingCourses.length) out.push(h("p", { class: "note note-warn" }, `Sin calendario para ${s.missingCourses.join(", ")}: solo se descuentan fines de semana.`));
  return out;
}

function leaveSection(app: App, key: string, view: AnnualView) {
  // Los cupos son por año natural: en la vista por curso se muestran los dos años que toca.
  const years = view === "anio_natural" ? [key] : [annualBounds(key).startsOn.slice(0, 4), annualBounds(key).endsOn.slice(0, 4)];
  const ctx = app.ctx();
  return h("section", { class: "block", "aria-labelledby": "t-cupos" },
    h("h2", { id: "t-cupos" }, "Vacaciones y permisos"),
    h("table", { class: "breakdown" },
      h("thead", {}, h("tr", {}, h("th", { scope: "col" }, "Año"), h("th", { scope: "col" }, "Tipo"),
        h("th", { scope: "col" }, "Disfrutados"), h("th", { scope: "col" }, "Planificados"), h("th", { scope: "col" }, "Quedan"))),
      h("tbody", {}, years.flatMap((y) => (["vacaciones_contrato", "permiso_personal"] as const).map((cat) => {
        const u = leaveUsage(cat, y, ctx);
        return h("tr", {},
          h("th", { scope: "row" }, y),
          h("td", {}, cat === "vacaciones_contrato" ? "Vacaciones" : "Permiso personal"),
          h("td", {}, String(u.used + u.prior), u.prior ? h("span", { class: "muted small" }, ` (${u.prior} fuera de la app)`) : null),
          h("td", {}, String(u.planned)),
          h("td", { class: u.remaining < 0 ? "neg" : "" }, `${u.remaining} de ${u.allowance}`,
            u.estimatedCourses.length || u.missingCourses.length
              ? h("span", { class: "muted small", title: `Falta el calendario real de ${[...u.estimatedCourses, ...u.missingCourses].join(", ")}` }, " (provisional)")
              : null),
        );
      }))),
    ),
  );
}

function balanceSection(app: App, course: CourseLabel) {
  const host = h("section", { class: "block", "aria-labelledby": "t-saldo" }, h("h2", { id: "t-saldo" }, "Saldo del curso"));
  const ctx = app.ctx();
  const next = shiftAnnualKey(course, 1);
  void (async () => {
    const carriedIn = await app.loadCarryover(course);
    const outgoing = await app.loadCarryover(next);
    const bal = courseBalance(course, ctx, carriedIn);
    host.append(
      h("p", {}, `Saldo propio: ${formatHours(bal.ownBalance, true)}.`,
        bal.carriedIn ? ` Traído del curso ${carriedIn!.fromCourse}: ${formatHours(bal.carriedIn, true)}.` : "",
        ` Total: ${formatHours(bal.totalBalance, true)}.`),
    );
    if (outgoing) {
      host.append(h("p", {}, `Trasladado al curso ${next}: ${formatHours(outgoing.hours, true)} (${dateShort(outgoing.createdAt.slice(0, 10))}).`));
      const drift = carryoverDrift(outgoing, bal);
      if (drift) host.append(h("p", { class: "note note-warn" },
        `El saldo de este curso ha cambiado desde el traslado (de ${formatHours(drift.before, true)} a ${formatHours(drift.now, true)}). Puedes rehacer el traslado.`));
    }
    if (!bal.finished) {
      host.append(h("p", { class: "muted" }, "Cuando termine el curso podrás trasladar el saldo al siguiente."));
      return;
    }
    if (!app.repo) return void host.append(h("p", { class: "muted" }, "Conecta con GitHub en Ajustes para trasladar el saldo."));
    host.append(h("button", {
      type: "button", class: "btn btn-primary",
      onclick: async () => {
        const input = h("input", { type: "number", id: "co-hours", step: "0.25", value: String(Math.round(bal.totalBalance * 100) / 100) });
        const note = h("input", { type: "text", id: "co-note", maxlength: 200 });
        const ok = await dialog(`Trasladar saldo a ${next}`, [
          h("p", {}, `Saldo total del curso ${course}: ${formatHours(bal.totalBalance, true)}. Puedes trasladarlo entero, una parte o nada (0).`),
          h("label", { for: "co-hours" }, "Horas a trasladar"), input,
          h("label", { for: "co-note" }, "Nota (opcional)"), note,
        ], [{ label: "Cancelar", value: "no" }, { label: "Trasladar", value: "si", kind: "primary" }]);
        if (ok !== "si") return;
        const file = buildCarryover(bal, next, Number(input.value), nowUtc(), note.value);
        try {
          app.carryovers[next] = await saveCarryover(app.repo!, file);
          toast("Saldo trasladado.");
          app.render();
        } catch (e) {
          toast((e as Error).message, "error");
        }
      },
    }, outgoing ? "Rehacer el traslado" : `Trasladar saldo a ${next}`));
  })();
  return host;
}

