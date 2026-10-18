import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "./ui/styles.css";
import { App, type Route } from "./ui/app";
import { h } from "./ui/dom";
import { ficharView } from "./ui/views/fichar";
import { historialView } from "./ui/views/historial";
import { resumenView } from "./ui/views/resumen";
import { calendarioView } from "./ui/views/calendario";
import { ajustesView } from "./ui/views/ajustes";
import { conflictosView } from "./ui/views/conflictos";

const app = new App();
const ROUTES: Record<Route, (a: App) => HTMLElement> = {
  fichar: ficharView, historial: historialView, resumen: resumenView,
  calendario: calendarioView, ajustes: ajustesView, conflictos: conflictosView,
};
const NAV: [Route, string][] = [["fichar", "Fichar"], ["historial", "Historial"], ["resumen", "Resumen"], ["calendario", "Calendario"], ["ajustes", "Ajustes"]];

const route = (): Route => {
  const r = location.hash.slice(1) as Route;
  return r in ROUTES ? r : "fichar";
};

const SYNC_TEXT: Record<string, string> = {
  local: "Solo en este dispositivo",
  ok: "Sincronizado",
  pendiente: "Cambios por enviar",
  sin_red: "Sin conexión: se enviará después",
  credenciales: "Revisa el token en Ajustes",
  error: "Error al sincronizar",
  sincronizando: "Sincronizando…",
};

function render(background = false) {
  const main = document.getElementById("main")!;
  const nav = document.getElementById("nav")!;
  const status = document.getElementById("status")!;
  const r = route();
  // Lo que llega de fondo no redibuja mientras se escribe o hay un diálogo abierto
  // (se perdería lo tecleado); se aplica al terminar.
  if (background) {
    const active = document.activeElement;
    const typing = active && main.contains(active) && ["INPUT", "TEXTAREA", "SELECT"].includes(active.tagName);
    if (typing || document.querySelector("dialog[open]")) { pendingRender = true; return; }
  }
  pendingRender = false;

  const pending = app.pendingCount();
  const conflicts = app.conflictCount();
  status.replaceChildren(...[
    h("span", { class: `sync sync-${app.sync.kind}`, title: app.sync.message ?? "" },
      SYNC_TEXT[app.sync.kind], pending && app.sync.kind !== "ok" ? ` (${pending})` : ""),
    conflicts ? h("a", { href: "#conflictos", class: "conflicts" }, `${conflicts} cambio(s) sin aplicar`) : null,
    app.tokenWarning() ? h("a", { href: "#ajustes", class: "conflicts" }, app.tokenWarning()!) : null,
  ].filter((x): x is HTMLElement => x !== null));
  nav.replaceChildren(...NAV.map(([id, label]) =>
    h("a", { href: `#${id}`, class: "nav-item", "aria-current": r === id ? "page" : undefined }, label)));
  main.replaceChildren(ROUTES[r](app));
}

let pendingRender = false;
app.onRender(render);
window.addEventListener("hashchange", () => { pendingRender = false; render(); window.scrollTo(0, 0); });
document.addEventListener("focusout", () => setTimeout(() => { if (pendingRender) render(true); }, 0));
document.addEventListener("close", () => setTimeout(() => { if (pendingRender) render(true); }, 0), true);
// El tiempo en curso se actualiza cada 30 s en la pantalla de fichar.
setInterval(() => { if (route() === "fichar") render(true); }, 30_000);

void app.start();

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("./sw.js", { scope: "./" }).then(async () => {
    const reg = await navigator.serviceWorker.ready;
    const urls = [location.href.split("#")[0]!, ...performance.getEntriesByType("resource").map((e) => e.name)];
    reg.active?.postMessage({ type: "cache-urls", urls });
  });
}
