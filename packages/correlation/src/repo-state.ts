/**
 * Persists per-repo indexing state in a KV store.
 *
 * Key format: `repo-state:<name>` → JSON-serialised RepoState.
 */

import type { KVStore } from "@mma/storage";
import type { DiscoverySource, RepoState, RepoStatus } from "./types.js";

const KEY_PREFIX = "repo-state:";

function key(name: string): string {
  return KEY_PREFIX + name;
}

function parse(raw: string): RepoState {
  return JSON.parse(raw) as RepoState;
}

export class RepoStateManager {
  constructor(private readonly kv: KVStore) {}

  /** Get state for a single repo. */
  async get(name: string): Promise<RepoState | undefined> {
    const raw = await this.kv.get(key(name));
    return raw === undefined ? undefined : parse(raw);
  }

  /** Get all repo states. */
  async getAll(): Promise<RepoState[]> {
    const entries = await this.kv.getByPrefix(KEY_PREFIX);
    return [...entries.values()].map(parse);
  }

  /** Get repos filtered by status. */
  async getByStatus(status: RepoStatus): Promise<RepoState[]> {
    const all = await this.getAll();
    return all.filter((r) => r.status === status);
  }

  /**
   * Add a new repo as candidate.
   * Idempotent — won't overwrite an existing state entry.
   */
  async addCandidate(
    repo: {
      name: string;
      url: string;
      defaultBranch?: string;
      language?: string;
    },
    discoveredVia: DiscoverySource,
  ): Promise<RepoState> {
    const existing = await this.get(repo.name);
    if (existing !== undefined) {
      return existing;
    }

    const state: RepoState = {
      name: repo.name,
      url: repo.url,
      defaultBranch: repo.defaultBranch,
      language: repo.language,
      status: "candidate",
      discoveredVia,
      discoveredAt: new Date().toISOString(),
      connectionCount: 0,
    };

    await this.kv.set(key(repo.name), JSON.stringify(state));
    return state;
  }

  /**
   * Transition a repo from `candidate` to `indexing`.
   * Throws if the repo is not in `candidate` state.
   */
  async startIndexing(name: string): Promise<RepoState> {
    const existing = await this.#requireExisting(name);

    if (existing.status !== "candidate") {
      throw new Error(
        `Cannot start indexing repo "${name}": expected status "candidate" but got "${existing.status}"`,
      );
    }

    const updated: RepoState = { ...existing, status: "indexing" };
    await this.kv.set(key(name), JSON.stringify(updated));
    return updated;
  }

  /**
   * Transition a repo from `indexing` to `indexed`.
   * Throws if the repo is not in `indexing` state.
   */
  async markIndexed(name: string): Promise<RepoState> {
    const existing = await this.#requireExisting(name);

    if (existing.status !== "indexing") {
      throw new Error(
        `Cannot mark repo "${name}" as indexed: expected status "indexing" but got "${existing.status}"`,
      );
    }

    const updated: RepoState = {
      ...existing,
      status: "indexed",
      indexedAt: new Date().toISOString(),
    };
    await this.kv.set(key(name), JSON.stringify(updated));
    return updated;
  }

  /**
   * Mark a repo as `ignored`.
   * Can be applied from `candidate` or `indexed` state.
   */
  async markIgnored(name: string): Promise<RepoState> {
    const existing = await this.#requireExisting(name);

    if (existing.status !== "candidate" && existing.status !== "indexed") {
      throw new Error(
        `Cannot ignore repo "${name}": expected status "candidate" or "indexed" but got "${existing.status}"`,
      );
    }

    const updated: RepoState = {
      ...existing,
      status: "ignored",
      ignoredAt: new Date().toISOString(),
    };
    await this.kv.set(key(name), JSON.stringify(updated));
    return updated;
  }

  /**
   * Re-activate an `ignored` repo as `candidate`.
   */
  async unignore(name: string): Promise<RepoState> {
    const existing = await this.#requireExisting(name);

    if (existing.status !== "ignored") {
      throw new Error(
        `Cannot unignore repo "${name}": expected status "ignored" but got "${existing.status}"`,
      );
    }

    // Reset ignoredAt when re-activating; set a fresh discoveredAt timestamp.
    const { ignoredAt: _dropped, ...rest } = existing;
    const updated: RepoState = {
      ...rest,
      status: "candidate",
      discoveredAt: new Date().toISOString(),
    };
    await this.kv.set(key(name), JSON.stringify(updated));
    return updated;
  }

  /**
   * Reset a repo from `indexing` back to `candidate` (e.g. on indexing failure).
   * Throws if the repo is not in `indexing` state.
   */
  async resetToCandidate(name: string): Promise<RepoState> {
    const existing = await this.#requireExisting(name);

    if (existing.status !== "indexing") {
      throw new Error(
        `Cannot reset repo "${name}" to candidate: expected status "indexing" but got "${existing.status}"`,
      );
    }

    const updated: RepoState = { ...existing, status: "candidate" };
    await this.kv.set(key(name), JSON.stringify(updated));
    return updated;
  }

  /** Update the connection count for a repo. */
  async updateConnectionCount(name: string, count: number): Promise<RepoState> {
    const existing = await this.#requireExisting(name);
    const updated: RepoState = { ...existing, connectionCount: count };
    await this.kv.set(key(name), JSON.stringify(updated));
    return updated;
  }

  /** Remove a repo from state tracking entirely. */
  async remove(name: string): Promise<void> {
    await this.kv.delete(key(name));
  }

  /** Get summary counts by status. */
  async summary(): Promise<Record<RepoStatus, number>> {
    const all = await this.getAll();
    const counts: Record<RepoStatus, number> = {
      candidate: 0,
      indexing: 0,
      indexed: 0,
      ignored: 0,
    };
    for (const r of all) {
      counts[r.status]++;
    }
    return counts;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  async #requireExisting(name: string): Promise<RepoState> {
    const existing = await this.get(name);
    if (existing === undefined) {
      throw new Error(`Repo "${name}" not found in state store`);
    }
    return existing;
  }
}
