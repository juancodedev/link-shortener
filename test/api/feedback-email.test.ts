import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/db/client", () => ({ withClient: vi.fn() }));

import { getFeedbackEmail, setFeedbackEmail, isPlausibleEmail } from "../../src/api/tenants";
import { withClient } from "../../src/db/client";

// ---------------------------------------------------------------------------
// Where a business wants its feedback sent — PHASE A.
//
// Records intent. Sends nothing. The gate path is untouched, so nothing here can
// break a customer's submission, and equally nothing here means a review does
// NOT reach the address yet.
//
// These tests are here to keep that honest: if a future change starts claiming
// the address does something, the label and the README should change with it,
// and a reviewer should be able to see from this file exactly what is true.
// ---------------------------------------------------------------------------

function mockQuery(rows: unknown[]) {
  vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
    fn({ query: vi.fn().mockResolvedValue({ rows, rowCount: rows.length }) }),
  );
}

function context(options: { body?: unknown; bodyThrows?: boolean; tenant?: unknown } = {}) {
  const json = vi.fn().mockImplementation((payload: unknown, status: number) =>
    Promise.resolve(new Response(JSON.stringify(payload), { status })),
  );
  const c: any = {
    env: {},
    get: vi.fn().mockReturnValue(
      "tenant" in options
        ? options.tenant
        : { tenantId: "tenant-uuid", schemaName: "tenant_a7f3", tenantSlug: "acme" },
    ),
    req: { json: options.bodyThrows ? vi.fn().mockRejectedValue(new Error("bad")) : vi.fn().mockResolvedValue(options.body ?? {}) },
    json,
  };
  return { c, json };
}


/**
 * Asserts what a handler answered.
 *
 * `c.json(payload)` leaves the status implicit, so the default is applied here
 * rather than forcing every handler to write `, 200` for a test's convenience.
 */
function answeredWith(json: any, payload: unknown, status = 200) {
  expect(json).toHaveBeenCalledTimes(1);
  expect(json.mock.calls[0]![0]).toEqual(payload);
  expect(json.mock.calls[0]![1] ?? 200).toBe(status);
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("reading the feedback address", () => {
  it("returns what is stored", async () => {
    mockQuery([{ feedback_email: "hola@cafecentral.com" }]);
    const { c, json } = context();

    await getFeedbackEmail(c);

    answeredWith(json, { feedback_email: "hola@cafecentral.com" });
  });

  it("reports an unconfigured tenant as null, not as an error", async () => {
    // Every existing tenant is in this state and the product must keep working.
    mockQuery([{ feedback_email: null }]);
    const { c, json } = context();

    await getFeedbackEmail(c);

    answeredWith(json, { feedback_email: null });
  });

  it("refuses an unauthenticated caller", async () => {
    const { c, json } = context({ tenant: undefined });

    await getFeedbackEmail(c);

    answeredWith(json, { error: "unauthenticated" }, 401);
  });

  it("scopes the read to THIS tenant", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation((sql: string, p: unknown[]) => {
          queries.push(sql);
          params.push(p);
          return Promise.resolve({ rows: [{ feedback_email: null }] });
        }),
      }),
    );

    await getFeedbackEmail(context().c);

    expect(params[0]).toEqual(["tenant-uuid"]);
    expect(queries[0]).toContain("WHERE id = $1");
  });
});

describe("saving the feedback address", () => {
  it("stores what the owner typed", async () => {
    mockQuery([{ feedback_email: "hola@cafecentral.com" }]);
    const { c, json } = context({ body: { feedback_email: "hola@cafecentral.com" } });

    await setFeedbackEmail(c);

    answeredWith(json, { feedback_email: "hola@cafecentral.com" });
  });

  it("trims, because a pasted address carries a trailing newline", async () => {
    const params: unknown[][] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation((_sql: string, p: unknown[]) => {
          params.push(p);
          return Promise.resolve({ rows: [{ feedback_email: p[0] }] });
        }),
      }),
    );

    await setFeedbackEmail(context({ body: { feedback_email: "  hola@cafe.com \n" } }).c);

    // What is written is the trimmed value, not what was typed.
    expect(params[0]![0]).toBe("hola@cafe.com");
  });

  it("treats an emptied field as clearing, not as an error", async () => {
    const params: unknown[][] = [];
    vi.mocked(withClient).mockImplementation(async (_env: any, fn: any) =>
      fn({
        query: vi.fn().mockImplementation((_sql: string, p: unknown[]) => {
          params.push(p);
          return Promise.resolve({ rows: [{ feedback_email: p[0] }] });
        }),
      }),
    );

    await setFeedbackEmail(context({ body: { feedback_email: "" } }).c);

    // A browser submits "" for an emptied field, and an owner who no longer
    // wants this set must be able to say so.
    expect(params[0]![0]).toBeNull();
  });

  it("refuses an address that cannot deliver", async () => {
    const { c, json } = context({ body: { feedback_email: "not-an-address" } });

    await setFeedbackEmail(c);

    expect(json.mock.calls[0]![0]).toMatchObject({ code: "invalid_email" });
    expect(json.mock.calls[0]![0].detail).toBeTruthy();
    expect(json.mock.calls[0]![1] ?? 200).toBe(400);
  });

  it("refuses an address that is too long to be real", async () => {
    const { c, json } = context({
      body: { feedback_email: `${"a".repeat(250)}@example.com` },
    });

    await setFeedbackEmail(c);

    // The column is TEXT so nothing below would stop it. A value that long is a
    // paste accident, and storing it puts junk in the registry that every
    // print run then carries.
    expect(json.mock.calls[0]![0]).toMatchObject({ code: "invalid_email" });
    expect(json.mock.calls[0]![1] ?? 200).toBe(400);
  });

  it("never touches the database when the body is unreadable", async () => {
    const { c, json } = context({ bodyThrows: true });

    await setFeedbackEmail(c);

    expect(json.mock.calls[0]![0]).toMatchObject({ code: "invalid_request" });
    expect(json.mock.calls[0]![1] ?? 200).toBe(400);
    expect(withClient).not.toHaveBeenCalled();
  });

  it("refuses an unauthenticated caller before any database work", async () => {
    const { c, json } = context({ tenant: undefined, body: { feedback_email: "a@b.com" } });

    await setFeedbackEmail(c);

    answeredWith(json, { error: "unauthenticated" }, 401);
    expect(withClient).not.toHaveBeenCalled();
  });
});

describe("what counts as an address", () => {
  // Deliberately loose. Strict RFC 5322 validation rejects addresses that
  // deliver, and a form that refuses real addresses teaches its owner that the
  // form is unreliable.
  it.each([
    "a@b.co",
    "hola@cafecentral.com",
    "someone+tag@example.co.uk",
    "first.last@example.com",
    "a_b-c@sub.domain.example",
  ])("accepts %s", (value) => {
    expect(isPlausibleEmail(value)).toBe(true);
  });

  it.each([
    ["no at sign", "nope"],
    ["two at signs", "a@b@c.com"],
    ["nothing before the at", "@example.com"],
    ["nothing after the at", "a@"],
    ["a space, which cannot deliver", "a b@example.com"],
    ["a newline pasted from somewhere", "a@b.com\n"],
    ["a tab", "a@b\t.com"],
  ])("rejects %s", (_label, value) => {
    expect(isPlausibleEmail(value as string)).toBe(false);
  });
});