import { describe, expect, it } from "vitest";
import { inlineScripts } from "../helpers/inline-scripts";

describe("inlineScripts", () => {
  it("returns inline script bodies in document order", () => {
    expect(inlineScripts("<p></p><script>a()</script><div></div><script>b()</script>")).toEqual(["a()", "b()"]);
  });

  it("skips external scripts loaded with src", () => {
    const html = '<script src="https://unpkg.com/x.js"></script><script>run()</script>';

    expect(inlineScripts(html)).toEqual(["run()"]);
  });

  it("accepts end tags with whitespace or upper case, which a browser also closes", () => {
    expect(inlineScripts("<SCRIPT>a()</SCRIPT ><script>b()</script\n>")).toEqual(["a()", "b()"]);
  });
});
