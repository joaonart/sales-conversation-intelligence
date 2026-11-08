import { describe, expect, it } from "vitest";
import { cx } from "../../src/ui/lib/cx";
import { fmtDt, fmtInt, fmtUsd, isoDay } from "../../src/ui/lib/format";
import { parseHash } from "../../src/ui/app/router";
import { logoutUrl } from "../../src/ui/app/AccountMenu";
import { SESSION_ID } from "../../src/ui/app/Shell";
import { auditValue } from "../../src/ui/views/AuditView";

describe("ui lib", () => {
  it("cx skips falsy parts", () => expect(cx("a", false, null, undefined, "b")).toBe("a b"));
  it("missing numbers are a dash, never 0 or NaN", () => {
    expect(fmtInt(null)).toBe("—");
    expect(fmtUsd("")).toBe("—");
    expect(fmtDt("not a date")).toBe("—");
    expect(fmtInt(1234)).toBe("1.234");
  });
  it("isoDay counts back from a given day", () => expect(isoDay(29, new Date("2026-11-08T12:00:00Z"))).toBe("2026-10-10"));
  it("parses hash routes and defaults to the dashboard", () => {
    expect(parseHash("")).toEqual({ name: "dashboard", parts: [] });
    expect(parseHash("#/sessions/abc")).toEqual({ name: "sessions", parts: ["abc"] });
  });
  it("only an Apps Script address may be the sign-out return", () => {
    const ok = "https://script.google.com/a/macros/j-nart.com/s/AKfy_1/exec";
    expect(logoutUrl(ok)).toContain(encodeURIComponent(ok));
    expect(logoutUrl("https://evil.example/exec")).toBe("https://accounts.google.com/Logout");
    expect(logoutUrl(null)).toBe("https://accounts.google.com/Logout");
  });
  it("validates session ids like the server", () => {
    expect(SESSION_ID.test("exemplo-001-t9")).toBe(true);
    expect(SESSION_ID.test("../x")).toBe(false);
  });
  it("formats audit detail values", () => {
    expect(auditValue(true)).toBe("Sim");
    expect(auditValue(null)).toBe("—");
    expect(auditValue({ a: 1 })).toBe('{"a":1}');
  });
});
