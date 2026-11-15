import { describe, expect, it, vi } from "vitest";
import { applyFilters } from "../../src/ui/lib/usePagedList";

describe("applyFilters (what Buscar does)", () => {
  it("different filters become the applied ones, and the list follows them by itself", () => {
    const search = vi.fn();
    const set = vi.fn();
    applyFilters({ search }, { q: "b" }, { q: "a" }, set);
    expect(set).toHaveBeenCalledWith({ q: "b" });
    expect(search).not.toHaveBeenCalled();
  });

  it("the same filters search the list again instead of doing nothing", () => {
    const search = vi.fn();
    const set = vi.fn();
    applyFilters({ search }, { q: "a", from: "2026-10-01" }, { q: "a", from: "2026-10-01" }, set); // the same filters, as a different object (a draft is a copy)
    expect(search).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });
});
