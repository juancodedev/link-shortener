import { act, cleanup, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { button, installClipboard, installLegacy, link, mountLinks, panel, standardApi } from "./harness";

// The QR modal a row's "QR code" button opens. Ported from the Worker tests
// that ran the served showQR and the #copy-print-sheet listener
// (test/handlers/dashboard.test.ts: "the QR image encodes the short URL, not
// its encoded form", and the island's QR hand-off in edits.test.tsx).

let alerts: string[];

beforeEach(() => {
  installLegacy();
  alerts = [];
  vi.stubGlobal("alert", (m: string) => alerts.push(m));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const modal = () => document.getElementById("qr-modal") as HTMLDivElement;
const isShown = () => !modal().classList.contains("hidden");
const img = () => document.getElementById("qr-img") as HTMLImageElement;
const caption = () => document.getElementById("qr-url")!.textContent;
const copyButton = () => document.getElementById("copy-print-sheet") as HTMLButtonElement;

async function openFor(shortUrl: string) {
  standardApi({ links: [link({ short_url: shortUrl })] });
  await mountLinks();
  await act(async () => {
    fireEvent.click(button(panel(), "QR code"));
  });
  return {
    // Exactly what the QR service receives as `data`, after its own decode.
    payload: new URL(img().src).searchParams.get("data"),
    raw: img().src,
  };
}

describe("QR modal — the image", () => {
  it("opens from the row, without the legacy window.__showQR", async () => {
    // The legacy bridge is gone from the page; nothing on window is needed.
    delete (window as unknown as Record<string, unknown>).__showQR;

    await openFor("https://shorter.juancode.dev/X4tonhH");

    expect(modal().className).toBe("qr-modal");
    expect(img().src.startsWith("https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=")).toBe(true);
  });

  it("round-trips a plain short URL through the query parameter, encoded exactly once", async () => {
    const url = "https://shorter.juancode.dev/X4tonhH";
    const { payload, raw } = await openFor(url);

    expect(payload).toBe(url);
    expect(raw).toContain("data=https%3A%2F%2Fshorter.juancode.dev%2FX4tonhH");
    expect(raw).not.toContain("%253A");
  });

  it("still encodes reserved characters so the query parameter survives", async () => {
    const awkward = "https://shorter.juancode.dev/a?b=1&c=2#frag";
    const { payload, raw } = await openFor(awkward);

    expect(payload).toBe(awkward);
    expect(raw).toContain("%26");
  });

  it("shows the same bytes the QR encodes, never a decoded form (a literal % must not throw)", async () => {
    const odd = "https://shorter.juancode.dev/a%zz";
    const { payload } = await openFor(odd);

    expect(caption()).toBe(odd);
    expect(caption()).toBe(payload);
  });

  it("shows markup in a short URL as text", async () => {
    await openFor('https://x.test/"><img src=x onerror=alert(1)>');

    expect(caption()).toBe('https://x.test/"><img src=x onerror=alert(1)>');
    expect(modal().querySelectorAll("img")).toHaveLength(1);
  });
});

describe("QR modal — closing", () => {
  it("closes on the backdrop and on Close, not on a click inside the card", async () => {
    await openFor("https://short.link/a");
    expect(isShown()).toBe(true);

    fireEvent.click(modal().querySelector(".qr-card")!);
    expect(isShown()).toBe(true);
    fireEvent.click(modal());
    expect(isShown()).toBe(false);

    await act(async () => {
      fireEvent.click(button(panel(), "QR code"));
    });
    expect(isShown()).toBe(true);
    fireEvent.click(button(modal(), "Close"));
    expect(isShown()).toBe(false);
  });
});

describe("QR modal — copy for the print sheet", () => {
  it("copies the URL the modal shows, and says so for a moment", async () => {
    const written = installClipboard();
    await openFor("https://short.link/a?x=1&y=2");
    vi.useFakeTimers();

    await act(async () => {
      fireEvent.click(copyButton());
    });

    expect(written).toEqual([caption()]);
    expect(written).toEqual(["https://short.link/a?x=1&y=2"]);
    expect(copyButton().textContent).toBe("Copied!");

    act(() => {
      vi.advanceTimersByTime(1500);
    });
    expect(copyButton().textContent).toBe("Copy URL for print sheet");
  });

  it("asks for a manual copy when the clipboard refuses", async () => {
    installClipboard(true);
    await openFor("https://short.link/a");

    await act(async () => {
      fireEvent.click(copyButton());
    });

    expect(alerts).toEqual(["Copy failed — select the URL above and copy it manually."]);
    expect(copyButton().textContent).toBe("Copy URL for print sheet");
  });
});
