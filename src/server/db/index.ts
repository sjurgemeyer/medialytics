import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { migrations, type Migration } from './migrations.js';

export type Db = Database.Database;

export const openDatabase = (file: string): Db => {
    if (file !== ':memory:') {
        mkdirSync(dirname(file), { recursive: true });
    }
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
    return db;
};

export const schemaVersion = (db: Db): number => {
    db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const row = db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as { version: number | null };
    return row.version ?? 0;
};

export const migrate = (db: Db, pending: Migration[] = migrations): number => {
    const current = schemaVersion(db);
    const toApply = pending.filter(migration => migration.version > current).sort((a, b) => a.version - b.version);
    for (const migration of toApply) {
        db.transaction(() => {
            db.exec(migration.sql);
            db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(migration.version);
        })();
    }
    return schemaVersion(db);
};
