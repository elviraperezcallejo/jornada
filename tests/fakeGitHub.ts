import { base64ToUtf8, utf8ToBase64 } from "../src/storage/base64";

/**
 * Servidor falso de la API de contenidos para pruebas: guarda ficheros en
 * memoria y aplica la regla del sha (si no coincide → 409).
 */
export class FakeGitHub {
  files = new Map<string, { text: string; sha: string }>();
  isPrivate = true;
  canPush: boolean | undefined = true;
  token = "tok";
  requests: { method: string; path: string }[] = [];
  /** Ejecutado justo antes de procesar el siguiente PUT (para simular otro dispositivo). */
  beforeNextPut: (() => void) | null = null;
  private counter = 0;

  nextSha() {
    return `sha${++this.counter}`;
  }

  setFile(path: string, text: string) {
    this.files.set(path, { text, sha: this.nextSha() });
  }

  /** Simula estar sin conexión: fetch lanza un error de red. */
  offline = false;

  fetch: typeof fetch = async (input, init) => {
    if (this.offline) throw new TypeError("Failed to fetch");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("Authorization");
    this.requests.push({ method, path: url.pathname });
    if (auth !== `Bearer ${this.token}`) return json(401, { message: "Bad credentials" });

    const m = /^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.+))?$/.exec(url.pathname);
    if (!m) return json(404, { message: "Not Found" });
    const path = m[3] ? decodeURIComponent(m[3]) : null;

    if (path === null) {
      const perms = this.canPush === undefined ? undefined : { push: this.canPush };
      return json(200, { full_name: `${m[1]}/${m[2]}`, private: this.isPrivate, permissions: perms });
    }
    if (method === "GET") {
      const prefix = path.replace(/\/$/, "") + "/";
      const under = [...this.files.entries()].filter(([k]) => k.startsWith(prefix));
      if (!this.files.has(path) && under.length) {
        const seen = new Map<string, { type: string; name: string; path: string; sha: string }>();
        for (const [k, v] of under) {
          const rest = k.slice(prefix.length);
          const name = rest.split("/")[0]!;
          const isDir = rest.includes("/");
          if (!seen.has(name)) {
            seen.set(name, { type: isDir ? "dir" : "file", name, path: prefix + name, sha: isDir ? `dir-${name}` : v.sha });
          }
        }
        return json(200, [...seen.values()]);
      }
      const f = this.files.get(path);
      if (!f) return json(404, { message: "Not Found" });
      // GitHub parte el Base64 en líneas de 60 caracteres.
      const b64 = utf8ToBase64(f.text).replace(/(.{60})/g, "$1\n");
      return json(200, { type: "file", encoding: "base64", content: b64, sha: f.sha });
    }
    if (method === "PUT") {
      if (this.beforeNextPut) {
        const fn = this.beforeNextPut;
        this.beforeNextPut = null;
        fn();
      }
      const body = JSON.parse(String(init?.body)) as { content: string; sha?: string };
      const existing = this.files.get(path);
      if (existing && body.sha !== existing.sha) return json(409, { message: "is at X but expected Y" });
      if (!existing && body.sha) return json(409, { message: "file does not exist" });
      const sha = this.nextSha();
      this.files.set(path, { text: base64ToUtf8(body.content), sha });
      return json(existing ? 200 : 201, { content: { sha } });
    }
    return json(405, { message: "Method not allowed" });
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
