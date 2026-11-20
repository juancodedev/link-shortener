import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearPrintQueue,
  getPrintQueue,
  prunePrintQueue,
  setPrintQueued,
  subscribePrintQueue,
} from "../src/print-queue";
import { stubApi } from "./api-stub";

// The print queue moved from the legacy page into this store
// (odd/tasks/dashboard-react.md T3a). These pin what the legacy
// setPrintQueued / syncPrintQueue / clearPrintQueue / renderPrintQueue did
// (formerly compiled out of the served HTML in test/handlers/dashboard.test.ts,
// "print queue as page state"). Every reader imports this module; nothing
// about the queue is published on window.

describe("print queue store", () => {
  let events = 0;
  let stop = () => {};

  beforeEach(() => {
    document.body.innerHTML = '<span id="cards-count" class="side-count" hidden></span>';
    clearPrintQueue();
    events = 0;
    stop = subscribePrintQueue(() => events++);
  });

  afterEach(() => {
    stop();
    document.body.innerHTML = "";
  });

  it("queues a link on the click itself, keeping its code and the click order", () => {
    setPrintQueued("a", true, "AAA");
    setPrintQueued("b", true, "BBB");
    setPrintQueued("a", true, "AAA");

    expect(getPrintQueue()).toEqual([{ id: "a", short_code: "AAA" }, { id: "b", short_code: "BBB" }]);
    expect(events).toBe(3);
  });

  it("takes a link out of the queue", () => {
    setPrintQueued("a", true, "AAA");
    setPrintQueued("b", true, "BBB");

    setPrintQueued("a", false);

    expect(getPrintQueue()).toEqual([{ id: "b", short_code: "BBB" }]);
  });

  it("drops links that got a destination or were deleted when the table reloads", () => {
    setPrintQueued("kept", true, "K");
    setPrintQueued("configured", true, "C");
    setPrintQueued("deleted", true, "D");
    events = 0;

    prunePrintQueue([
      { id: "kept", original_url: null },
      { id: "configured", original_url: "https://g.page/r/x" },
      { id: "other", original_url: null },
    ]);

    expect(getPrintQueue()).toEqual([{ id: "kept", short_code: "K" }]);
    expect(events).toBe(1);
  });

  it("empties the batch after a print run", () => {
    setPrintQueued("a", true, "AAA");
    setPrintQueued("b", true, "BBB");
    events = 0;

    clearPrintQueue();

    expect(getPrintQueue()).toEqual([]);
    expect(events).toBe(1);
  });

  it("puts nothing on window: the migration bridge is gone", () => {
    setPrintQueued("a", true, "AAA");

    for (const name of ["__printQueue", "__setPrintQueued", "__clearPrintQueue"]) {
      expect(name in window).toBe(false);
    }
  });

  it("hands out a new array on every change, never the same one edited", () => {
    const before = getPrintQueue();
    setPrintQueued("a", true, "AAA");

    expect(getPrintQueue()).not.toBe(before);
    expect(before).toEqual([]);
  });

  it("shows the queue size in the sidebar badge, hidden when empty", () => {
    const badge = document.getElementById("cards-count")!;

    setPrintQueued("a", true, "AAA");
    setPrintQueued("b", true, "BBB");
    expect(badge.textContent).toBe("2");
    expect(badge.hidden).toBe(false);

    clearPrintQueue();
    expect(badge.textContent).toBe("0");
    expect(badge.hidden).toBe(true);
  });

  it("keeps the queue in page memory: no request, and empty in a fresh page", async () => {
    const api = vi.fn();
    const fetchSpy = vi.fn();
    stubApi(api);
    vi.stubGlobal("fetch", fetchSpy);

    setPrintQueued("a", true, "AAA");
    prunePrintQueue([{ id: "a", original_url: null }]);
    clearPrintQueue();

    expect(api).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    vi.resetModules();
    const fresh = await import("../src/print-queue");
    expect(fresh.getPrintQueue()).toEqual([]);
  });
});
