import { neon } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set in environment variables');
}

// neon() returns a tagged-template SQL executor — no connection pool needed
// for serverless; works perfectly with NeonDB's HTTP transport.
export const sql = neon(process.env.DATABASE_URL);

// Typed helper for single-row selects
export async function queryOne<T>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T | null> {
  const rows = await sql(strings, ...values);
  return (rows[0] as T) ?? null;
}
