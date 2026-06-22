import { Client } from "pg";
import type { AppEnv } from "../types/env";

/**
 * Creates a new pg.Client connected via Hyperdrive connection string.
 * Hyperdrive manages connection pooling — creating a new Client per request
 * is the correct pattern. Always call client.end() after use to return the
 * connection to the pool.
 */
export function createClient(env: AppEnv): Client {
  return new Client({
    connectionString: env.HYPERDRIVE.connectionString,
  });
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
