/**
 * Constraint route stubs — constraints package excluded from open-source build.
 * All endpoints return 404 Not Found.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { KVStore } from "@mma/storage";
import { sendError, type ParsedQuery } from "../http-utils.js";

export async function handleConstraints(
  _req: IncomingMessage,
  res: ServerResponse,
  _kvStore: KVStore,
  _query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  return sendError(res, "Constraints API not available in this build", 404, corsOrigin);
}

export async function handleConstraintDetail(
  _req: IncomingMessage,
  res: ServerResponse,
  _kvStore: KVStore,
  _type: string,
  _query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  return sendError(res, "Constraints API not available in this build", 404, corsOrigin);
}

export async function handleCrossEntityDeps(
  _req: IncomingMessage,
  res: ServerResponse,
  _kvStore: KVStore,
  _query: ParsedQuery,
  corsOrigin: string | undefined,
): Promise<void> {
  return sendError(res, "Constraints API not available in this build", 404, corsOrigin);
}

export async function handleValidateConstraints(
  _req: IncomingMessage,
  res: ServerResponse,
  _kvStore: KVStore,
  corsOrigin: string | undefined,
): Promise<void> {
  return sendError(res, "Constraints API not available in this build", 404, corsOrigin);
}
