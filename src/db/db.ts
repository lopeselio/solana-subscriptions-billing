import { readFile } from 'node:fs/promises';

/** Minimal surface shared by node-postgres and PGlite. */
export interface Db {
    query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
    exec(sql: string): Promise<void>;
    close(): Promise<void>;
}

export async function connectPostgres(url: string): Promise<Db> {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: url });
    return {
        query: async <T>(sql: string, params?: unknown[]) => {
            const res = await pool.query(sql, params);
            return { rows: res.rows as T[] };
        },
        exec: async sql => {
            await pool.query(sql);
        },
        close: () => pool.end(),
    };
}

/** In-process Postgres (WASM). Used by tests; also handy for a zero-setup local run. */
export async function connectPglite(dataDir?: string): Promise<Db> {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = new PGlite(dataDir);
    return {
        query: async <T>(sql: string, params?: unknown[]) => {
            const res = await pg.query<T>(sql, params);
            return { rows: res.rows };
        },
        exec: async sql => {
            await pg.exec(sql);
        },
        close: () => pg.close(),
    };
}

export async function connect(url: string): Promise<Db> {
    if (url.startsWith('pglite:')) {
        const dir = url.slice('pglite:'.length);
        return connectPglite(dir === '' || dir === 'memory' ? undefined : dir);
    }
    return connectPostgres(url);
}

export async function migrate(db: Db): Promise<void> {
    const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await db.exec(sql);
}
