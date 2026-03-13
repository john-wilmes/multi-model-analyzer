/**
 * LRU cache for query results.
 *
 * Caches results of repeated structural and search queries to avoid
 * redundant graph traversals and BM25 lookups. Cache entries are evicted
 * when the capacity is exceeded (least recently used first) or when
 * a TTL expires.
 */

export interface QueryCacheOptions {
  /** Maximum number of cached entries. Default: 128. */
  readonly maxSize?: number;
  /** Time-to-live in milliseconds. 0 = no expiry. Default: 300_000 (5 min). */
  readonly ttlMs?: number;
}

interface CacheEntry<T> {
  value: T;
  createdAt: number;
}

export class QueryCache<T = unknown> {
  private readonly maxSize: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, CacheEntry<T>>();

  constructor(options?: QueryCacheOptions) {
    this.maxSize = options?.maxSize ?? 128;
    this.ttlMs = options?.ttlMs ?? 300_000;
  }

  /**
   * Get a cached value by key. Returns undefined on miss or expiry.
   * On hit, moves the entry to the most-recently-used position.
   */
  get(key: string): T | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;

    // Check TTL
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }

    // Move to end (most recently used) by re-inserting
    this.cache.delete(key);
    this.cache.set(key, entry);

    return entry.value;
  }

  /**
   * Store a value in the cache. Evicts the LRU entry if at capacity.
   */
  set(key: string, value: T): void {
    // If key already exists, delete it first to refresh position
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else {
      // Only evict when inserting a NEW key that would exceed capacity.
      if (this.cache.size >= this.maxSize) {
        const firstKey = this.cache.keys().next().value as string;
        this.cache.delete(firstKey);
      }
    }

    this.cache.set(key, { value, createdAt: Date.now() });
  }

  /**
   * Check if a key exists and is not expired.
   * Does NOT move the entry to MRU position — use get() when you want that.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (this.ttlMs > 0 && Date.now() - entry.createdAt > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /** Remove a specific key. */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /** Remove all cached entries. */
  clear(): void {
    this.cache.clear();
  }

  /** Number of currently cached entries (including potentially expired). */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Build a cache key from query parameters.
   * Deterministic: same inputs always produce the same key.
   */
  static buildKey(parts: readonly (string | number | undefined)[]): string {
    return parts.map((p) => p ?? "").join("::");
  }
}
