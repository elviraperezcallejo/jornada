import {
  clockState,
  globalErrors,
  planAdd,
  planClockIn,
  planDelete,
  planEdit,
  planToggle,
  sessionsTouchingDay,
  upsert,
  describeError,
  type Plan,
} from "../src/domain/sessions";
import type { WorkSession } from "../src/domain/types";

// Horas de Madrid en octubre de 2026 (antes del 25/10): UTC+2.
const M = (madrid: string) => new Date(`${madrid}+02:00`).toISOString();

const closed = (id: string, start: string, end: string): WorkSession => ({
  id, updatedAt: end, start, end, origin: "boton",
});
const open = (id: string, start: string): WorkSession => ({ id, updatedAt: start, start, end: null, origin: "boton" });

function apply(all: WorkSession[], plan: Plan): WorkSession[] {
  if (!plan.ok) throw new Error(describeError(plan.error));
  return plan.ops.reduce((acc, o) => upsert(acc, o.session), all);
}

describe("estado del botón", () => {
  it("sin fichajes: sin fichar", () => {
    expect(clockState([], M("2026-10-16T08:00:00")).kind).toBe("sin_fichar");
  });

  it("entrar y salir el mismo día", () => {
    let all = apply([], planToggle([], { now: M("2026-10-16T08:00:00") }));
    const st = clockState(all, M("2026-10-16T09:00:00"));
    expect(st.kind).toBe("fichado");
    expect(st.kind === "fichado" && st.open.start).toBe(M("2026-10-16T08:00:00"));
    all = apply(all, planToggle(all, { now: M("2026-10-16T14:30:00") }));
    expect(all).toHaveLength(1);
    expect(all[0]!.end).toBe(M("2026-10-16T14:30:00"));
    expect(clockState(all, M("2026-10-16T15:00:00")).kind).toBe("sin_fichar");
  });

  it("una pausa son dos fichajes: salir y volver a entrar", () => {
    let all: WorkSession[] = [];
    for (const t of ["08:00", "11:00", "11:30", "14:00"]) {
      all = apply(all, planToggle(all, { now: M(`2026-10-16T${t}:00`) }));
    }
    expect(all.map((s) => [s.start, s.end])).toEqual([
      [M("2026-10-16T08:00:00"), M("2026-10-16T11:00:00")],
      [M("2026-10-16T11:30:00"), M("2026-10-16T14:00:00")],
    ]);
  });
});

describe("fichar dos veces seguidas", () => {
  it("un doble toque en menos de 5 s no sale ni entra", () => {
    const all = apply([], planToggle([], { now: M("2026-10-16T08:00:00") }));
    const p = planToggle(all, { now: M("2026-10-16T08:00:03") });
    expect(p.ok === false && p.error.code).toBe("demasiado_rapido");
  });

  it("'Entrar' con una entrada ya abierta se rechaza (p. ej. desde otro dispositivo)", () => {
    const all = [open("a", M("2026-10-16T08:00:00"))];
    const p = planClockIn(all, { now: M("2026-10-16T09:00:00") });
    expect(p.ok === false && p.error.code).toBe("ya_fichado");
  });
});

describe("salida olvidada y cruce de medianoche", () => {
  const all = [open("a", M("2026-10-16T22:00:00"))];
  const afterMidnight = M("2026-10-17T00:30:00");

  it("una entrada de ayer abierta queda pendiente de revisión", () => {
    expect(clockState(all, afterMidnight).kind).toBe("pendiente_revision");
  });

  it("al pulsar Salir, pregunta en vez de inventar la hora", () => {
    const p = planToggle(all, { now: afterMidnight });
    expect(p.ok === false && p.error.code).toBe("requiere_confirmacion");
    expect(p.ok === false && describeError(p.error)).toMatch(/¿Sales ahora o olvidaste/);
  });

  it("'salgo ahora' = cruce de medianoche válido", () => {
    const out = apply(all, planToggle(all, { now: afterMidnight, resolution: "ahora" }));
    expect(out[0]!.end).toBe(afterMidnight);
  });

  it("'olvidé fichar' = se guarda la hora real que indica el usuario", () => {
    const out = apply(all, planToggle(all, { now: afterMidnight, resolution: M("2026-10-16T23:15:00") }));
    expect(out[0]!.end).toBe(M("2026-10-16T23:15:00"));
  });

  it("rechaza una salida futura o anterior a la entrada", () => {
    const f = planToggle(all, { now: afterMidnight, resolution: M("2026-10-17T02:00:00") });
    expect(f.ok === false && f.error.code).toBe("hora_futura");
    const b = planToggle(all, { now: afterMidnight, resolution: M("2026-10-16T21:00:00") });
    expect(b.ok === false && b.error.code).toBe("salida_no_posterior");
  });

  it("no deja entrar de nuevo hasta resolver el pendiente", () => {
    const p = planClockIn(all, { now: M("2026-10-19T08:00:00") });
    expect(p.ok === false && p.error.code).toBe("pendiente_revision");
  });

  it("un olvido de hace días se resuelve con su hora real", () => {
    const old = [open("a", M("2026-10-13T08:00:00"))];
    const out = apply(old, planToggle(old, { now: M("2026-10-16T09:00:00"), resolution: M("2026-10-13T15:00:00") }));
    expect(out[0]!.end).toBe(M("2026-10-13T15:00:00"));
  });

  it("el fichaje que cruza medianoche aparece en el historial de ambos días", () => {
    const s = [closed("a", M("2026-10-16T22:00:00"), M("2026-10-17T01:00:00"))];
    const now = M("2026-10-18T10:00:00");
    expect(sessionsTouchingDay(s, "2026-10-16", now)).toHaveLength(1);
    expect(sessionsTouchingDay(s, "2026-10-17", now)).toHaveLength(1);
    expect(sessionsTouchingDay(s, "2026-10-18", now)).toHaveLength(0);
  });
});

describe("historial: añadir, corregir y eliminar", () => {
  const base = [closed("a", M("2026-10-15T08:00:00"), M("2026-10-15T14:00:00"))];
  const now = M("2026-10-16T10:00:00");

  it("añade un fichaje olvidado", () => {
    const out = apply(base, planAdd(base, { start: M("2026-10-14T08:00:00"), end: M("2026-10-14T15:00:00"), note: " olvidé " }, now));
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ origin: "manual", note: "olvidé" });
  });

  it("rechaza uno que se solapa o que está en el futuro", () => {
    const s = planAdd(base, { start: M("2026-10-15T13:00:00"), end: M("2026-10-15T15:00:00") }, now);
    expect(s.ok === false && s.error.code).toBe("solape");
    const f = planAdd(base, { start: M("2026-10-16T09:00:00"), end: M("2026-10-16T11:00:00") }, now);
    expect(f.ok === false && f.error.code).toBe("hora_futura");
  });

  it("corrige un fichaje dentro del mismo mes", () => {
    const p = planEdit(base, "a", { start: M("2026-10-15T08:30:00"), end: M("2026-10-15T14:00:00") }, now);
    expect(p.ok && p.ops).toHaveLength(1);
    expect(p.ok && p.ops[0]!.baseUpdatedAt).toBe(base[0]!.updatedAt);
  });

  it("al moverlo a otro mes crea uno nuevo y borra el antiguo (en ese orden)", () => {
    const p = planEdit(base, "a", { start: M("2026-09-30T08:00:00"), end: M("2026-09-30T14:00:00") }, now);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.ops.map((o) => o.month)).toEqual(["2026-09", "2026-10"]);
    expect(p.ops[0]!.session.id).not.toBe("a");
    expect(p.ops[1]!.session).toMatchObject({ id: "a", deleted: true });
  });

  it("elimina dejando una lápida que ya no cuenta", () => {
    const out = apply(base, planDelete(base, "a", now));
    expect(out[0]!.deleted).toBe(true);
    expect(clockState(out, now)).toEqual({ kind: "sin_fichar", lastSession: null });
  });
});

describe("reglas entre meses", () => {
  it("detecta un solape entre el último fichaje de un mes y el primero del siguiente", () => {
    // Desde el 25/10 Madrid está en UTC+1.
    const s = [
      closed("a", new Date("2026-10-31T22:00:00+01:00").toISOString(), new Date("2026-11-01T01:00:00+01:00").toISOString()),
      closed("b", new Date("2026-11-01T00:30:00+01:00").toISOString(), new Date("2026-11-01T02:00:00+01:00").toISOString()),
    ];
    expect(globalErrors(s).join()).toMatch(/solaparían/);
  });
});
