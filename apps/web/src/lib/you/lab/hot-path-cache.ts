// ═══════════════════════════════════════════════════════════════════════════
// Hot-path cache — deterministic sub-results keyed by content hash (P6.C12).
//
// The lab benchmark executor regenerates the SAME deterministic world (by
// seed) and recompiles the SAME organizations (by pipeline genomes) on every
// run. Those sub-results are pure functions of their inputs, so a
// content-hash memo cache is semantically transparent: same input → the
// EXACT same output object, byte-for-byte.
//
// The compute functions are INJECTED (dependency-injected parameters, not
// imports): world.ts / organization-compiler.ts use extensionless relative
// imports that the node:test type-stripping loader cannot resolve, so this
// module deliberately imports NOTHING at runtime except node:crypto — the
// same zero-import law as compute-routing.ts. App callers pass their own
// compute functions; node:test suites pass test doubles.
//
// Honesty laws:
//  - the cache is keyed by a REAL content hash (sha256 over the
//    stable-stringified inputs — not an object identity, not a seed guess);
//  - hits/misses are counted and surfaced (the benchmark run records them —
//    a hit is labeled a hit, a miss a miss);
//  - the cache is PROCESS-LOCAL and bounded (MAX_ENTRIES per store, evict
//    oldest-inserted first) — disclosed, never implied to be shared;
//  - nothing that depends on real provider calls is ever cached here (the
//    grounding calls stay per-run measurements — caching them would fake
//    latency evidence).
// ═══════════════════════════════════════════════════════════════════════════
import { createHash } from 'crypto';
import type { LabWorldSpec, PipelineGenome } from '../contracts';

export const MAX_CACHE_ENTRIES = 32;

export interface CacheStats {
  /** true when this call was served from the cache. */
  readonly hit: boolean;
  /** lifetime hits for this store (process-local counter). */
  readonly hits: number;
  /** lifetime misses for this store (process-local counter). */
  readonly misses: number;
  /** the content-hash key that decided the lookup (sha256 hex, 16 chars shown). */
  readonly key: string;
}

interface HotPathCacheGlobalStore {
  __youWorldCache?: Map<string, unknown>;
  __youWorldCacheStats?: { hits: number; misses: number };
  __youOrgCache?: Map<string, unknown>;
  __youOrgCacheStats?: { hits: number; misses: number };
}
const cacheGlobal = globalThis as typeof globalThis & HotPathCacheGlobalStore;
const worldCache: Map<string, unknown> = (cacheGlobal.__youWorldCache ??= new Map());
const worldStats = (cacheGlobal.__youWorldCacheStats ??= { hits: 0, misses: 0 });
const orgCache: Map<string, unknown> = (cacheGlobal.__youOrgCache ??= new Map());
const orgStats = (cacheGlobal.__youOrgCacheStats ??= { hits: 0, misses: 0 });

function contentKey(...parts: unknown[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(stableKey(p));
  return h.digest('hex').slice(0, 16);
}

/** stable-stringify (the determinism.ts algorithm, inlined to stay zero-import). */
function stableKey(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((v) => stableKey(v)).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const obj = value as Record<string, unknown>;
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableKey(obj[k])}`).join(',')}}`;
}

function getOrCompute<V>(
  store: Map<string, unknown>,
  stats: { hits: number; misses: number },
  key: string,
  compute: () => V,
): { value: V; stats: CacheStats } {
  const cached = store.get(key);
  if (cached !== undefined) {
    stats.hits += 1;
    return { value: cached as V, stats: { hit: true, hits: stats.hits, misses: stats.misses, key } };
  }
  const value = compute();
  if (store.size >= MAX_CACHE_ENTRIES) {
    // evict the oldest-inserted entry (Map preserves insertion order)
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, value);
  stats.misses += 1;
  return { value, stats: { hit: false, hits: stats.hits, misses: stats.misses, key } };
}

export interface CachedWorld {
  readonly world: LabWorldSpec;
  readonly cache: CacheStats;
}

/**
 * generateWorld(seed) behind the content-hash memo cache. The compute
 * function is injected by the caller (executors pass lab/world.ts's
 * generateWorld; tests pass doubles) — see the module header for the law.
 */
export function cachedGenerateWorld(
  seed: number,
  computeWorld: (seed: number) => LabWorldSpec,
): CachedWorld {
  const key = contentKey({ fn: 'generateWorld', seed });
  const { value, stats } = getOrCompute(worldCache, worldStats, key, () => computeWorld(seed));
  return { world: value as LabWorldSpec, cache: stats };
}

/**
 * The pipelines shape the org-compile cache hashes over. Structurally the
 * PipelineRef set (organization-compiler.ts) — the compile output is driven
 * by the pipeline IDs + genomes, which is exactly what the content key
 * hashes (name is display-only and never changes a compile).
 */
export interface OrgCompilePipelines {
  readonly generalist: { id: string; name: string; genome: PipelineGenome };
  readonly handDesigned: { id: string; name: string; genome: PipelineGenome };
  readonly searched: { id: string; name: string; genome: PipelineGenome };
}

export interface CachedOrganizations<T> {
  readonly organizations: T;
  readonly cache: CacheStats;
}

/**
 * compileOrganizations(…) behind the content-hash memo cache. The key hashes
 * every pipeline id + genome — a mutated genome compiles to a DIFFERENT key
 * and never reuses the un-mutated compile (content-addressed, not
 * name-addressed). The compute function is injected (see the module header).
 */
export function cachedCompileOrganizations<T>(
  seed: number,
  pipelines: OrgCompilePipelines,
  computeOrganizations: (seed: number, pipelines: OrgCompilePipelines) => T,
): CachedOrganizations<T> {
  const key = contentKey({
    fn: 'compileOrganizations',
    seed,
    generalist: { id: pipelines.generalist.id, genome: pipelines.generalist.genome },
    handDesigned: { id: pipelines.handDesigned.id, genome: pipelines.handDesigned.genome },
    searched: { id: pipelines.searched.id, genome: pipelines.searched.genome },
  });
  const { value, stats } = getOrCompute(orgCache, orgStats, key, () =>
    computeOrganizations(seed, pipelines),
  );
  return { organizations: value, cache: stats };
}

/** Test-only: drop both caches and their counters. */
export function resetHotPathCacheForTests(): void {
  worldCache.clear();
  orgCache.clear();
  worldStats.hits = 0;
  worldStats.misses = 0;
  orgStats.hits = 0;
  orgStats.misses = 0;
}
