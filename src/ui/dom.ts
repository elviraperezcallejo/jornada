/**
 * Pequeño ayudante para construir la interfaz sin innerHTML: todo el texto
 * se inserta como texto (nunca como HTML), para que ningún dato pueda
 * inyectar código en la página donde está guardado el token.
 */
type Child = Node | string | number | null | undefined | false | Child[];
type Attrs = Record<string, string | number | boolean | EventListener | undefined | null>;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === "class") el.className = String(v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  append(el, children);
  return el;
}

function append(el: Node, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
  }
}

/** Mensaje breve en la parte inferior. */
export function toast(text: string, kind: "info" | "error" = "info") {
  const host = document.getElementById("toasts")!;
  const t = h("div", { class: `toast toast-${kind}`, role: kind === "error" ? "alert" : "status" }, text);
  host.appendChild(t);
  setTimeout(() => t.remove(), kind === "error" ? 7000 : 3500);
}

/** Diálogo modal con acciones. Devuelve el valor de la acción elegida (o null si se cierra). */
export function dialog<T extends string>(
  title: string,
  body: Child,
  actions: { label: string; value: T; kind?: "primary" | "danger" | "plain" }[],
): Promise<T | null> {
  return new Promise((resolve) => {
    const d = h("dialog", { class: "dialog", "aria-labelledby": "dlg-title" },
      h("h2", { id: "dlg-title" }, title),
      h("div", { class: "dialog-body" }, body),
      h("div", { class: "dialog-actions" },
        actions.map((a) => h("button", {
          type: "button", class: `btn btn-${a.kind ?? "plain"}`,
          onclick: () => { d.close(); resolve(a.value); },
        }, a.label)),
      ),
    );
    d.addEventListener("cancel", () => resolve(null));
    d.addEventListener("close", () => d.remove());
    document.body.appendChild(d);
    d.showModal();
  });
}

export async function confirmDanger(title: string, text: string, action: string): Promise<boolean> {
  return (await dialog(title, h("p", {}, text), [
    { label: "Cancelar", value: "no" },
    { label: action, value: "si", kind: "danger" },
  ])) === "si";
}

export function download(filename: string, content: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = h("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
