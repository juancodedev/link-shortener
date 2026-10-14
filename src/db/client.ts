import { Client } from "pg";
import type { AppEnv } from "../types/env";

/**
 * Creates a new pg.Client connected via Hyperdrive (production) or direct
 * connection string (local dev via DATABASE_URL env var).
 *
 * Hyperdrive manages connection pooling — creating a new Client per request
 * is the correct pattern. Always call client.end() after use to return the
 * connection to the pool.
 */
const CONNECTION_OPTIONS = "-c hyperdrive_query_cache=false";

export function createClient(env: AppEnv): Client {
  // Production / --remote: Hyperdrive handles connection pooling
  if (env.HYPERDRIVE?.connectionString) {
    return new Client({
      connectionString: env.HYPERDRIVE.connectionString,
      options: CONNECTION_OPTIONS,
    });
  }
  // Local dev without --remote: use DATABASE_URL from .dev.vars
  if (env.DATABASE_URL) {
    return new Client({
      connectionString: env.DATABASE_URL,
      options: CONNECTION_OPTIONS,
    });
  }
  throw new Error("No database connection configured (set DATABASE_URL in .dev.vars or use --remote)");
}

/**
 * Helper that manages the full client lifecycle: connect → execute → end.
 * Ensures client.end() is called even if the callback throws.
 */
export async function withClient<T>(
  env: AppEnv,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = createClient(env);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}
