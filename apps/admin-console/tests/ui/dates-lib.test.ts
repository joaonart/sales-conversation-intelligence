import { describe, expect, it } from "vitest";
import { addDays, addMonths, clampDay, formatBr, maskBr, monthGrid, parseBr, parseIso, todayLocal, toIso, weekday } from "../../src/ui/lib/dates";

describe("calendar days as YYYY-MM-DD", () => {
  it("parses only real dates", () => {
    expect(parseIso("2026-10-01")).toEqual({ y: 2026, m: 10, d: 1 });
    for (const bad of ["2026-02-30", "2026-13-01", "2026-1-1", "01/10/2026", "", null, undefined, "2026-10-01T00:00"]) expect(parseIso(bad as string), String(bad)).toBeNull();
    expect(parseIso("2028-02-29")).not.toBeNull(); // a leap year
    expect(parseIso("2026-02-29")).toBeNull();
  });

  it("writes and reads dd/mm/aaaa", () => {
    expect(formatBr("2026-10-01")).toBe("01/10/2026");
    expect(formatBr("")).toBe("");
    expect(parseBr("01/10/2026")).toBe("2026-10-01");
    for (const bad of ["1/10/2026", "31/02/2026", "01-10-2026", "01/10/26", ""]) expect(parseBr(bad), bad).toBeNull();
  });

  it("masks what is typed: only digits, slashes by themselves, at most 8 digits", () => {
    expect(maskBr("0")).toBe("0");
    expect(maskBr("011")).toBe("01/1");
    expect(maskBr("01102")).toBe("01/10/2");
    expect(maskBr("01/10/2026")).toBe("01/10/2026");
    expect(maskBr("01a10b2026xx9")).toBe("01/10/2026");
    expect(maskBr("")).toBe("");
  });

  it("moves by days and by months, ending on the last day of a shorter month", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
    expect(addMonths("2026-12-15", 1)).toBe("2027-01-15");
    expect(addMonths("2026-01-15", -1)).toBe("2025-12-15");
    expect(addMonths("2026-03-31", 12)).toBe("2027-03-31");
  });

  it("knows the weekday (0 = Sunday) and builds a six-week grid starting on a Sunday", () => {
    expect(weekday("2026-11-14")).toBe(6); // a Saturday
    const g = monthGrid("2026-11-14");
    expect(g).toHaveLength(42);
    expect(weekday(g[0] as string)).toBe(0);
    expect(g).toContain("2026-11-01");
    expect(g).toContain("2026-11-30");
    expect(g[0]).toBe("2026-11-01"); // 1 Nov 2026 is a Sunday
    expect(monthGrid("nope")).toEqual([]);
  });

  it("holds a day inside the allowed range", () => {
    expect(clampDay("2026-10-01", "2026-10-05", "2026-10-20")).toBe("2026-10-05");
    expect(clampDay("2026-10-30", "2026-10-05", "2026-10-20")).toBe("2026-10-20");
    expect(clampDay("2026-10-10", "2026-10-05", "2026-10-20")).toBe("2026-10-10");
    expect(clampDay("2026-10-10")).toBe("2026-10-10");
  });

  it("today is the person's own day, not the UTC one (it must not be tomorrow in the evening of Brazil)", () => {
    expect(todayLocal(new Date(2026, 10, 14, 22, 30))).toBe("2026-11-14");
    expect(toIso(2026, 11, 14)).toBe("2026-11-14");
  });
});
