import { annualBounds, annualKeyOf, courseBounds, coursesCovering, shiftAnnualKey, courseOf, isCourseLabel, leavePeriodKey, madridDateOf, madridMonthOf, previousCourse } from "../src/domain/time";

describe("fechas en hora de Madrid", () => {
  it("una entrada el 31/10 a las 23:30 (Madrid) va al fichero de octubre", () => {
    // 31/10/2026 ya es horario de invierno (UTC+1): 23:30 Madrid = 22:30 UTC
    expect(madridMonthOf("2026-10-31T22:30:00.000Z")).toBe("2026-10");
  });

  it("las 23:30 UTC del 30/11 son ya el 01/12 en Madrid", () => {
    expect(madridMonthOf("2026-11-30T23:30:00.000Z")).toBe("2026-12");
    expect(madridDateOf("2026-11-30T23:30:00.000Z")).toBe("2026-12-01");
  });

  it("el día del cambio de hora (25/10/2026) se resuelve bien", () => {
    // 00:30 UTC = 02:30 hora de verano; 01:30 UTC = 02:30 hora de invierno
    expect(madridDateOf("2026-10-25T00:30:00.000Z")).toBe("2026-10-25");
    expect(madridDateOf("2026-10-25T01:30:00.000Z")).toBe("2026-10-25");
  });
});

describe("cursos (1 sep – 31 ago)", () => {
  it("asigna fechas al curso correcto", () => {
    expect(courseOf("2026-08-31")).toBe("2025-26");
    expect(courseOf("2026-09-01")).toBe("2026-27");
    expect(courseOf("2027-08-31")).toBe("2026-27");
  });

  it("calcula límites y curso anterior", () => {
    expect(courseBounds("2026-27")).toEqual({ startsOn: "2026-09-01", endsOn: "2027-08-31" });
    expect(previousCourse("2026-27")).toBe("2025-26");
    expect(courseOf("2099-10-01")).toBe("2099-00");
    expect(isCourseLabel("2099-00")).toBe(true);
    expect(isCourseLabel("2026-28")).toBe(false);
  });
});

describe("periodo de los cupos", () => {
  it("por año natural, agosto de 2027 cuenta en 2027 aunque sea del curso 2026-27", () => {
    expect(leavePeriodKey("2027-08-02", "anio_natural")).toBe("2027");
    expect(leavePeriodKey("2026-11-20", "anio_natural")).toBe("2026");
    expect(leavePeriodKey("2027-08-02", "curso")).toBe("2026-27");
  });
});

describe("vista anual: curso o año natural", () => {
  it("la misma fecha cae en periodos distintos según la vista", () => {
    expect(annualKeyOf("2026-10-12", "curso")).toBe("2026-27");
    expect(annualKeyOf("2026-10-12", "anio_natural")).toBe("2026");
    expect(annualKeyOf("2027-03-01", "curso")).toBe("2026-27");
    expect(annualKeyOf("2027-03-01", "anio_natural")).toBe("2027");
  });

  it("calcula límites y navega hacia delante y atrás", () => {
    expect(annualBounds("2027")).toEqual({ startsOn: "2027-01-01", endsOn: "2027-12-31" });
    expect(annualBounds("2026-27")).toEqual({ startsOn: "2026-09-01", endsOn: "2027-08-31" });
    expect(shiftAnnualKey("2026-27", 1)).toBe("2027-28");
    expect(shiftAnnualKey("2027", -1)).toBe("2026");
    expect(() => annualBounds("27")).toThrow();
  });

  it("un año natural necesita los calendarios de dos cursos", () => {
    expect(coursesCovering("2027-01-01", "2027-12-31")).toEqual(["2026-27", "2027-28"]);
    expect(coursesCovering("2026-09-01", "2027-08-31")).toEqual(["2026-27"]);
  });
});
