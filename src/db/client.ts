import { drizzle, type ExpoSQLiteDatabase } from 'drizzle-orm/expo-sqlite';
import { migrate } from 'drizzle-orm/expo-sqlite/migrator';
import * as SQLite from 'expo-sqlite';

import migrations from '../../drizzle/migrations';
import * as schema from './schema';

export const DATABASE_NAME = 'squeakly.db';

export type AppDatabase = ExpoSQLiteDatabase<typeof schema>;

let nativeDb: SQLite.SQLiteDatabase | null = null;
let database: AppDatabase | null = null;

/**
 * Opens the database synchronously so the very first render of Track can already read
 * today's count. `openDatabaseSync` is cheap; the migration pass is the only async part.
 */
export function openDatabase(): AppDatabase {
  if (database) return database;

  nativeDb = SQLite.openDatabaseSync(DATABASE_NAME, { enableChangeListener: true });
  nativeDb.execSync(
    'PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;',
  );
  database = drizzle(nativeDb, { schema, casing: 'snake_case' });
  return database;
}

export function getDatabase(): AppDatabase {
  if (!database) return openDatabase();
  return database;
}

/** Raw handle, needed for `withTransactionSync` and for the destructive wipe. */
export function getNativeDatabase(): SQLite.SQLiteDatabase {
  if (!nativeDb) openDatabase();
  if (!nativeDb) throw new Error('Database failed to open');
  return nativeDb;
}

export async function runMigrations(): Promise<void> {
  await migrate(getDatabase(), migrations);
}

/**
 * Destructive wipe used by Settings → Delete all data. Drops the file entirely rather
 * than deleting rows so no forensic remnants (including WAL pages) survive, then
 * recreates an empty schema.
 */
export async function destroyDatabase(): Promise<void> {
  if (nativeDb) {
    nativeDb.closeSync();
    nativeDb = null;
    database = null;
  }
  await SQLite.deleteDatabaseAsync(DATABASE_NAME);
  openDatabase();
  await runMigrations();
}

export { schema };
