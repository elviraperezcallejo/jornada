import { fullBackup, sessionsCsv } from "../../domain/export";
import { nowUtc } from "../../domain/time";
import type { ConfigFile, IsoWeekday, LeaveCategory } from "../../domain/types";
import { readCarryover } from "../../storage/carryover";
import type { App } from "../app";
import { confirmDanger, download, h, toast } from "../dom";

const DAYS: [IsoWeekday, string][] = [[1, "L"], [2, "M"], [3, "X"], [4, "J"], [5, "V"], [6, "S"], [7, "D"]];

export function ajustesView(app: App): HTMLElement {
  const cfg = app.config.get();
  const term = [...cfg.contractTerms].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]!;
  const c = app.connection;

  async function change(mutate: (c: ConfigFile) => ConfigFile, okMsg = "Ajustes guardados.") {
    const errs = await app.config.change(mutate);
    if (errs.length) return void toast(errs.join(" "), "error");
    toast(okMsg);
    void app.syncNow();
    app.render();
  }

  // ----- Conexión -----
  const owner = h("input", { type: "text", id: "c-owner", value: c?.owner ?? "", autocomplete: "username", required: true });
  const repo = h("input", { type: "text", id: "c-repo", value: c?.repo ?? "datos-jornada", required: true });
  const token = h("input", { type: "password", id: "c-token", value: c?.token ?? "", autocomplete: "off", required: true });
  const exp = h("input", { type: "date", id: "c-exp", value: c?.tokenExpiresOn ?? "" });

  const connection = h("form", {
    class: "block", "aria-labelledby": "t-con",
    onsubmit: async (e: Event) => {
      e.preventDefault();
      try {
        await app.connectWith({ owner: owner.value.trim(), repo: repo.value.trim(), token: token.value.trim(), tokenExpiresOn: exp.value || null });
        toast("Conectado. Tus datos se sincronizan con GitHub.");
      } catch (err) {
        toast((err as Error).message, "error");
      }
    },
  },
    h("h2", { id: "t-con" }, "Conexión con GitHub"),
    h("p", { class: "muted small" }, "El token se guarda solo en este navegador. Usa un repositorio privado y un token limitado a ese repositorio con permiso Contents: Read and write."),
    h("label", { for: "c-owner" }, "Tu usuario de GitHub"), owner,
    h("label", { for: "c-repo" }, "Repositorio privado de datos"), repo,
    h("label", { for: "c-token" }, "Token"), token,
    h("label", { for: "c-exp" }, "El token caduca el"), exp,
    h("div", { class: "actions" },
      h("button", { type: "submit", class: "btn btn-primary" }, c ? "Guardar y comprobar" : "Conectar"),
      c ? h("button", { type: "button", class: "btn btn-danger-quiet", onclick: async () => {
        if (!(await confirmDanger("Olvidar la conexión", "Se borrará el token de este navegador. Tus datos en GitHub no se tocan.", "Olvidar"))) return;
        app.forgetConnection();
      } }, "Olvidar en este dispositivo") : null,
    ),
  );

  // ----- Contrato -----
  const hours = h("input", { type: "number", id: "k-hours", min: "0.5", max: "168", step: "0.25", value: String(term.weeklyHours) });
  const from = h("input", { type: "date", id: "k-from", value: term.validFrom });
  const dayBoxes = DAYS.map(([d, l]) => h("label", { class: "day" },
    h("input", { type: "checkbox", value: String(d), checked: term.workdays.includes(d) }), l));
  const allowance = (cat: LeaveCategory) => String(term.leaveAllowances.find((a) => a.category === cat)?.days ?? 0);
  const vac = h("input", { type: "number", id: "k-vac", min: "0", max: "366", step: "1", value: allowance("vacaciones_contrato") });
  const per = h("input", { type: "number", id: "k-per", min: "0", max: "366", step: "1", value: allowance("permiso_personal") });

  const contract = h("form", {
    class: "block", "aria-labelledby": "t-k",
    onsubmit: (e: Event) => {
      e.preventDefault();
      const workdays = dayBoxes.map((b) => b.querySelector("input")!).filter((i) => i.checked).map((i) => Number(i.value) as IsoWeekday);
      const next = {
        validFrom: from.value, weeklyHours: Number(hours.value), workdays,
        leaveAllowances: [
          { category: "vacaciones_contrato" as const, days: Number(vac.value), period: "anio_natural" as const },
          { category: "permiso_personal" as const, days: Number(per.value), period: "anio_natural" as const },
        ],
      };
      // Si la fecha es la misma, se corrige; si es otra, se añade una versión nueva y el pasado no cambia.
      void change((c) => ({ ...c, contractTerms: [...c.contractTerms.filter((t) => t.validFrom !== next.validFrom), next] }));
    },
  },
    h("h2", { id: "t-k" }, "Contrato"),
    h("label", { for: "k-hours" }, "Horas semanales"), hours,
    h("fieldset", {}, h("legend", {}, "Días de trabajo"), h("div", { class: "days" }, dayBoxes)),
    h("label", { for: "k-vac" }, "Días de vacaciones al año (hábiles)"), vac,
    h("label", { for: "k-per" }, "Días de permiso por causas personales al año"), per,
    h("label", { for: "k-from" }, "Válido desde"), from,
    h("p", { class: "muted small" }, "Con otra fecha se crea una versión nueva del contrato; los periodos anteriores siguen con la antigua."),
    cfg.contractTerms.length > 1 ? h("p", { class: "muted small" }, `Versiones: ${cfg.contractTerms.map((t) => `${t.validFrom} (${t.weeklyHours} h)`).join(", ")}.`) : null,
    h("button", { type: "submit", class: "btn btn-primary" }, "Guardar contrato"),
  );

  // ----- Días usados fuera de la app -----
  const pYear = h("input", { type: "number", id: "p-year", min: "2000", max: "2100", value: app.today().slice(0, 4) });
  const pCat = h("select", { id: "p-cat" }, h("option", { value: "vacaciones_contrato" }, "Vacaciones"), h("option", { value: "permiso_personal" }, "Permiso personal"));
  const pDays = h("input", { type: "number", id: "p-days", min: "0", max: "366", value: "0" });
  const prior = h("form", {
    class: "block", "aria-labelledby": "t-p",
    onsubmit: (e: Event) => {
      e.preventDefault();
      const item = { periodKey: pYear.value, category: pCat.value as LeaveCategory, days: Number(pDays.value) };
      void change((c) => ({ ...c, priorLeaveUsage: [...c.priorLeaveUsage.filter((p) => !(p.periodKey === item.periodKey && p.category === item.category)), ...(item.days ? [item] : [])] }));
    },
  },
    h("h2", { id: "t-p" }, "Días ya usados antes de la app"),
    cfg.priorLeaveUsage.length
      ? h("ul", {}, cfg.priorLeaveUsage.map((p) => h("li", {}, `${p.periodKey}: ${p.days} de ${p.category === "vacaciones_contrato" ? "vacaciones" : "permiso personal"}`)))
      : h("p", { class: "muted small" }, "Ninguno."),
    h("div", { class: "inline" },
      h("div", {}, h("label", { for: "p-year" }, "Año"), pYear),
      h("div", {}, h("label", { for: "p-cat" }, "Tipo"), pCat),
      h("div", {}, h("label", { for: "p-days" }, "Días"), pDays)),
    h("button", { type: "submit", class: "btn" }, "Guardar días"),
  );

  // ----- Calendario y exportación -----
  const track = h("input", { type: "date", id: "g-track", value: cfg.trackingStartsOn ?? "" });
  const campus = h("input", { type: "text", id: "g-campus", value: cfg.calendarImport.campus });
  const centre = h("input", { type: "text", id: "g-centre", value: cfg.calendarImport.centre });
  const est = h("input", { type: "checkbox", id: "g-est", checked: cfg.estimateMissingCalendars });
  const sep = h("select", { id: "g-sep" }, h("option", { value: ";", selected: cfg.export.csvSeparator === ";" }, "Punto y coma (;)"), h("option", { value: ",", selected: cfg.export.csvSeparator === "," }, "Coma (,)"));
  const dec = h("input", { type: "checkbox", id: "g-dec", checked: cfg.export.decimalComma });
  const general = h("form", {
    class: "block", "aria-labelledby": "t-g",
    onsubmit: (e: Event) => {
      e.preventDefault();
      void change((c) => ({
        ...c, estimateMissingCalendars: est.checked, trackingStartsOn: track.value || null,
        calendarImport: { campus: campus.value.trim(), centre: centre.value.trim() },
        export: { csvSeparator: sep.value as ";" | ",", decimalComma: dec.checked },
      }));
    },
  },
    h("h2", { id: "t-g" }, "Registro, calendario y exportación"),
    h("label", { for: "g-track" }, "Empecé a registrar el (vacío: el día del primer fichaje)"), track,
    h("p", { class: "muted small" }, "Los días anteriores no cuentan, para que empezar a mitad de curso no aparezca como déficit."),
    h("label", { for: "g-campus" }, "Campus (fiestas locales)"), campus,
    h("label", { for: "g-centre" }, "Centro (tal y como aparece en el anexo del PDF)"), centre,
    h("label", { class: "check" }, est, "Si falta el calendario de un curso, estimarlo a partir del anterior"),
    h("label", { for: "g-sep" }, "Separador de los CSV"), sep,
    h("label", { class: "check" }, dec, "Coma decimal en los CSV"),
    h("button", { type: "submit", class: "btn btn-primary" }, "Guardar"),
  );

  const exportBlock = h("section", { class: "block", "aria-labelledby": "t-e" },
    h("h2", { id: "t-e" }, "Exportar"),
    h("div", { class: "actions" },
      h("button", { type: "button", class: "btn", onclick: () => download(`fichajes-${app.today()}.csv`, sessionsCsv(app.sessions.all(), cfg.export), "text/csv;charset=utf-8") }, "Fichajes (CSV)"),
      h("button", { type: "button", class: "btn", onclick: async () => {
        const cals = Object.values(app.calendars.calendars()).filter((x) => !!x);
        const carry = app.repo ? (await Promise.all(cals.map((x) => readCarryover(app.repo!, x!.course).catch(() => null)))).filter((x) => !!x) : [];
        download(`jornada-copia-${app.today()}.json`, fullBackup(cfg, cals as never, carry as never, app.sessions.all(), nowUtc()), "application/json");
      } }, "Copia completa (JSON)"),
    ),
  );

  return h("section", { class: "view", "aria-labelledby": "t-aj" },
    h("h1", { id: "t-aj" }, "Ajustes"),
    connection, contract, prior, general, exportBlock,
  );
}
