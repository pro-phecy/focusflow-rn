/**
 * Run this once to set up your NeonDB schema:
 *   npm run migrate
 */
import fs from 'fs';
import path from 'path';
import { Client } from '@neondatabase/serverless';
import dotenv from 'dotenv';

dotenv.config();

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

async function migrate() {
  const client = new Client(process.env.DATABASE_URL!);
  await client.connect();

  const schemaPath = path.join(__dirname, 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf-8');

  // Split on semicolons, skip empty strings
  const statements = schemaSql
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  console.log(`Running ${statements.length} SQL statements…`);

  for (const statement of statements) {
    try {
      await client.query(statement);
      console.log('✓', statement.slice(0, 70).replace(/\n/g, ' '));
    } catch (err: any) {
      if (
        err?.message?.includes('already exists') ||
        err?.code === '42P07' ||   // duplicate_table
        err?.code === '42710'      // duplicate_object
      ) {
        console.log('⚠ skipped (already exists):', statement.slice(0, 60));
        continue;
      }
      console.error('✗ Failed:', statement.slice(0, 80));
      console.error(err?.message ?? err);
      await client.end();
      process.exit(1);
    }
  }

  await client.end();
  console.log('\n✅ Migration complete!');
}

migrate();
