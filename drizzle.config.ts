import { defineConfig } from 'drizzle-kit';

/**
 * `driver: 'expo'` makes drizzle-kit emit a migrations bundle (`drizzle/migrations.js`)
 * that can be imported directly by the app and applied on device at boot.
 */
export default defineConfig({
  dialect: 'sqlite',
  driver: 'expo',
  schema: './src/db/schema.ts',
  out: './drizzle',
  strict: true,
  verbose: true,
});
