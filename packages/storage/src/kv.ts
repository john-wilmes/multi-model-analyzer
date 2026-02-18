/**
 * Key-value store adapter.
 *
 * POC: In-memory Map (LevelDB when persistence needed).
 * Scale: RocksDB.
 *
 * Stores: SCIP indexes, AST caches, SARIF results, summary index.
 */

export interface KVStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
  keys(prefix?: string): Promise<string[]>;
  clear(): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-memory KV store for POC and testing.
 * Replace with LevelDB adapter for persistent POC, RocksDB for scale.
 */
export class InMemoryKVStore implements KVStore {
  private store = new Map<string, string>();

  async get(key: string): Promise<string | undefined> {
    return this.store.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async has(key: string): Promise<boolean> {
    return this.store.has(key);
  }

  async keys(prefix?: string): Promise<string[]> {
    const allKeys = [...this.store.keys()];
    if (!prefix) return allKeys;
    return allKeys.filter((k) => k.startsWith(prefix));
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  async close(): Promise<void> {
    this.store.clear();
  }
}

// Typed wrappers for common stored data

export interface TypedKVStore<T> {
  get(key: string): Promise<T | undefined>;
  set(key: string, value: T): Promise<void>;
  delete(key: string): Promise<void>;
  has(key: string): Promise<boolean>;
}

export function createTypedKVStore<T>(
  store: KVStore,
  prefix: string,
): TypedKVStore<T> {
  const prefixedKey = (key: string) => `${prefix}:${key}`;

  return {
    async get(key: string): Promise<T | undefined> {
      const raw = await store.get(prefixedKey(key));
      if (raw === undefined) return undefined;
      return JSON.parse(raw) as T;
    },
    async set(key: string, value: T): Promise<void> {
      await store.set(prefixedKey(key), JSON.stringify(value));
    },
    async delete(key: string): Promise<void> {
      await store.delete(prefixedKey(key));
    },
    async has(key: string): Promise<boolean> {
      return store.has(prefixedKey(key));
    },
  };
}
