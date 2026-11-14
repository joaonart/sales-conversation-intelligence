// @vitest-environment happy-dom
import { cleanup, fireEvent, render as renderView, screen, waitFor, within } from "@testing-library/preact";
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChartSkeleton, DashboardSkeleton, DetailSkeleton, ListSkeleton, Skeleton, SkeletonRegion, TableSkeleton, TextSkeleton } from "../../src/ui/components/Skeleton";
import { SessionsView } from "../../src/ui/views/SessionsView";
import { Providers, pick, untilOffers } from "./helpers";

afterEach(cleanup);

describe("skeleton components", () => {
  it("a block is decoration (hidden from a screen reader) and pulses", () => {
    const { container } = renderView(<Skeleton class="h-4 w-24" />);
    const el = container.firstElementChild as HTMLElement;
    expect(el.getAttribute("aria-hidden")).toBe("true");
    expect(el.className).toContain("animate-pulse");
    expect(el.className).toContain("h-4 w-24");
  });

  it("a region announces itself once, as busy, with a label only a screen reader reads", () => {
    renderView(<SkeletonRegion label="Carregando sessões…"><Skeleton class="h-4" /></SkeletonRegion>);
    const r = screen.getByRole("status");
    expect(r.getAttribute("aria-busy")).toBe("true");
    expect(within(r).getByText("Carregando sessões…").className).toContain("sr-only");
  });

  it("a table skeleton keeps the real column headers and fills the rows with bars of different widths", () => {
    const { container } = renderView(<TableSkeleton headers={["Quando", "Quem", "Ação"]} rows={4} />);
    expect(Array.from(container.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["Quando", "Quem", "Ação"]);
    expect(container.querySelectorAll("tbody tr")).toHaveLength(4);
    expect(container.querySelectorAll("tbody td")).toHaveLength(12);
    const widths = new Set(Array.from(container.querySelectorAll("tbody .animate-pulse")).map((b) => b.className.split(" ").find((c) => c.startsWith("w-"))));
    expect(widths.size).toBeGreaterThan(2);
    expect(screen.getByRole("status").textContent).toContain("Carregando…");
  });

  it("the other shapes render (text, chart, list, detail, painel) and are announced as one region", () => {
    for (const ui of [<TextSkeleton lines={3} />, <ChartSkeleton />, <ListSkeleton rows={3} />, <DetailSkeleton />, <DashboardSkeleton />]) {
      const { container, unmount } = renderView(ui);
      expect(container.querySelectorAll(".animate-pulse").length).toBeGreaterThan(0);
      unmount();
    }
    renderView(<ListSkeleton rows={3} />);
    expect(screen.getAllByRole("status")).toHaveLength(1);
    cleanup();
    renderView(<DashboardSkeleton />);
    expect(screen.getAllByRole("status")).toHaveLength(1); // not one per card
  });

  it("the last line of a paragraph is shorter", () => {
    const { container } = renderView(<TextSkeleton lines={3} />);
    const bars = container.querySelectorAll(".animate-pulse");
    expect(bars[0]?.className).toContain("w-full");
    expect(bars[2]?.className).toContain("w-2/3");
  });
});

/** A fake `google.script.run` that keeps the answers of some methods until `release()` (so the page can be seen while it waits). */
function holdServer(handlers: Record<string, (p: Record<string, unknown>) => unknown>, held: string[]) {
  const pending: Array<() => void> = [];
  (globalThis as unknown as { google: unknown }).google = {
    script: {
      run: {
        ok: null as null | ((t: string) => void),
        withSuccessHandler(fn: (t: string) => void) {
          this.ok = fn;
          return this;
        },
        withFailureHandler() {
          return this;
        },
        rpc(json: string) {
          const { method, payload } = JSON.parse(json) as { method: string; payload: Record<string, unknown> };
          const respond = this.ok;
          const finish = () => respond?.(JSON.stringify({ ok: true, data: handlers[method]?.(payload) ?? {} }));
          if (held.includes(method)) pending.push(finish);
          else finish();
        },
      },
    },
  };
  return { release: () => pending.splice(0).forEach((f) => f()) };
}

describe("a list shows the skeleton while it is fetched", () => {
  const rows = [{ session_id: "s1", channel: "web", started_at: null, analysis_status: "COMPLETED", approval_status: "APPROVED", overall_score: 80, rubric_id: "q", rubric_version: 1 }];
  const handlers = { "sessions.list": () => ({ rows, nextCursor: null }), "sessions.count": () => ({ total: 1, sessions: 1 }), "sessions.channels": () => ["web"], "rubrics.ids": () => ["q"] };
  beforeEach(() => sessionStorage.clear());

  /** The skeleton's region (the page has other status messages, like the pager's). */
  const busy = async () => (await screen.findAllByRole("status")).find((r) => r.getAttribute("aria-busy") === "true") as HTMLElement;
  const mount = () => renderView(<Providers role="VIEWER"><SessionsView parts={[]} /></Providers>);
  void render;

  it("shows the real headers with placeholder rows while the first page loads, then the rows", async () => {
    const server = holdServer(handlers, ["sessions.list"]);
    mount();
    const region = await busy();
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(within(region).getAllByRole("columnheader", { hidden: true }).length).toBeGreaterThan(2);
    expect(screen.queryByText("s1")).toBeNull();
    expect(screen.queryByText(/\d+–\d+/)).toBeNull(); // the pager does not say "1–0" about a page it has not got yet
    server.release();
    await screen.findAllByText("s1");
    await waitFor(() => expect(screen.queryByText("Carregando…")).toBeNull());
  });

  it("a new search replaces the old rows with the skeleton instead of leaving them on screen, then shows the new ones", async () => {
    const server = holdServer(handlers, []);
    mount();
    await screen.findAllByText("s1");
    await untilOffers(() => screen.getByLabelText("Canal"), "web");
    pick(screen.getByLabelText("Canal"), "web"); // new filters: Buscar makes a new list (the same filters would not fetch again)
    const held = holdServer(handlers, ["sessions.list"]);
    fireEvent.click(screen.getByRole("button", { name: "Buscar" }));
    await waitFor(() => expect(screen.getAllByRole("status").some((r) => r.getAttribute("aria-busy") === "true")).toBe(true));
    expect(screen.queryByText("s1")).toBeNull(); // the old result is not shown as if it answered the new filters
    held.release();
    await screen.findAllByText("s1");
    expect(screen.getAllByRole("status").some((r) => r.getAttribute("aria-busy") === "true")).toBe(false);
    void server;
  });
});
