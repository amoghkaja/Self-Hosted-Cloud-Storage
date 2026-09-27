import { DEFAULT_SETTINGS, type Settings } from '@familycloud/shared/all';
import { sql } from 'drizzle-orm';
import type { Db } from '../db/client';
import { settings as settingsTable } from '../db/schema';

const TTL_MS = 5_000;

/** App-wide settings stored as one JSON document, cached briefly in memory. */
export class SettingsStore {
  private cached: { at: number; value: Settings } | null = null;

  constructor(private readonly db: Db) {}

  async get(): Promise<Settings> {
    if (this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.value;
    const [row] = await this.db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(sql`${settingsTable.key} = 'app'`);
    const value = { ...DEFAULT_SETTINGS, ...((row?.value as Partial<Settings>) ?? {}) };
    this.cached = { at: Date.now(), value };
    return value;
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch };
    await this.db
      .insert(settingsTable)
      .values({ key: 'app', value: next })
      .onConflictDoUpdate({
        target: settingsTable.key,
        set: { value: next, updatedAt: new Date() },
      });
    this.cached = { at: Date.now(), value: next };
    return next;
  }

  /** Arbitrary internal values (e.g. the first-run setup token) under their own key. */
  async getRaw<T>(key: string): Promise<T | null> {
    const [row] = await this.db
      .select({ value: settingsTable.value })
      .from(settingsTable)
      .where(sql`${settingsTable.key} = ${key}`);
    return (row?.value as T) ?? null;
  }

  async setRaw(key: string, value: unknown | null): Promise<void> {
    if (value === null) {
      await this.db.delete(settingsTable).where(sql`${settingsTable.key} = ${key}`);
      return;
    }
    await this.db
      .insert(settingsTable)
      .values({ key, value })
      .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
  }
}
