import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { getDb } from "./index.js";

export function runMigrations() {
  const db = getDb();
  migrate(db, { migrationsFolder: "./migrations" });
}
