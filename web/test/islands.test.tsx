import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { mountIslands } from "../src/islands";

describe("mountIslands", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders a registered island into the element that names it", async () => {
    document.body.innerHTML = '<section data-island="cards">legacy</section>';

    await act(async () => {
      mountIslands({ cards: () => <p>react cards</p> });
    });

    expect(document.querySelector('[data-island="cards"]')!.innerHTML).toBe("<p>react cards</p>");
  });

  it("leaves elements without a registered island untouched", async () => {
    document.body.innerHTML = '<section data-island="links">legacy links</section>';

    await act(async () => {
      expect(mountIslands({ cards: () => <p>x</p> })).toHaveLength(0);
    });

    expect(document.querySelector('[data-island="links"]')!.textContent).toBe("legacy links");
  });
});
