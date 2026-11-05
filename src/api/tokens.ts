import type { Repo } from '../db/repo.js';

/**
 * Dependency-injection tokens. Providers are injected by token rather than by type because
 * this project runs TypeScript through esbuild (tsx, Vitest), which doesn't emit the
 * decorator metadata Nest would otherwise use to resolve constructor types.
 */
export const REPO = Symbol('REPO');
export const API_OPTIONS = Symbol('API_OPTIONS');

export interface ApiOptions {
    repo: Repo;
    /** Optional bearer token. When unset the API is open — bind it to localhost. */
    apiKey?: string;
    graceSecs: bigint;
    /** Clock in unix seconds; injectable for tests. */
    now?: () => bigint;
}

/** What controllers need from ApiOptions, with the clock always present. */
export interface ApiSettings {
    apiKey?: string;
    graceSecs: bigint;
    now: () => bigint;
}
