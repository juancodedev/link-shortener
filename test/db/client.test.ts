import { describe, it, expect, vi, beforeEach } from "vitest";

// pg's Client is the only thing this module constructs, so it is mocked to
// observe the connection parameters actually handed to it.
// `new Client(...)` needs a constructible mock — an arrow function on vi.fn
// throws "is not a constructor" the moment createClient is called.
vi.mock("pg", () => {
  const ctor = vi.fn(function (this: Record<string, unknown>, config: unknown) {
    this.config = config;
  });
  return { Client: ctor };
});

import { Client } from "pg";
import { createClient } from "../../src/db/client";

/** The options string the last-constructed client received, if any. */
function optionsOf(): string | undefined {
  const calls = vi.mocked(Client).mock.calls;
  return (calls[calls.length - 1]?.[0] as { options?: string } | undefined)?.options;
}

describe("createClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("connects through Hyperdrive when a connection string is bound", () => {
    const client = createClient({
      HYPERDRIVE: { connectionString: "postgres://hyperdrive" },
    } as never);

    expect(client).toBeDefined();
    expect(vi.mocked(Client).mock.calls[0]![0]).toMatchObject({
      connectionString: "postgres://hyperdrive",
    });
  });

  // The correctness guarantee. Hyperdrive caches query results, so a write
  // followed by a read on another connection can return the pre-write value.
  // For billing state that means a tenant marked past_due keeps serving
  // printed stickers, and one just marked active stays paused.
  it("disables the Hyperdrive query cache on every connection", () => {
    createClient({ HYPERDRIVE: { connectionString: "postgres://hyperdrive" } } as never);

    expect(optionsOf()).toBe("-c hyperdrive_query_cache=false");
  });

  // A bug that hides locally and appears only in production is worse than one
  // that shows up everywhere, so the direct-connection path must behave the
  // same way even though the setting is a no-op there.
  it("passes the same option on the direct connection path", () => {
    createClient({ DATABASE_URL: "postgres://localhost:54322/postgres" } as never);

    expect(optionsOf()).toBe("-c hyperdrive_query_cache=false");
  });

  it("refuses to build a client with no connection configured", () => {
    expect(() => createClient({} as never)).toThrow(/No database connection configured/);
  });
});