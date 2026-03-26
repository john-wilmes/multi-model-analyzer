/**
 * HTTP utilities: query parsing, response helpers, static file serving,
 * CORS resolution, and TTL cache.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { join, extname, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

export interface ParsedQuery {
  single: Record<string, string>;
  multi: Record<string, string[]>;
}

export function parseQuery(url: string): ParsedQuery {
  const idx = url.indexOf("?");
  const result: ParsedQuery = { single: {}, multi: {} };
  if (idx === -1) return result;
  for (const part of url.slice(idx + 1).split("&")) {
    const [k, v] = part.split("=");
    if (!k) continue;
    const key = decodeURIComponent(k.replace(/\+/g, "%20"));
    const val = v ? decodeURIComponent(v.replace(/\+/g, "%20")) : "";
    if (!(key in result.single)) result.single[key] = val;
    if (!result.multi[key]) result.multi[key] = [];
    result.multi[key].push(val);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

export function sendJson(res: ServerResponse, data: unknown, status = 200, corsOrigin?: string): void {
  const body = JSON.stringify(data);
  const headers: Record<string, string | number> = {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  };
  if (corsOrigin) headers["Access-Control-Allow-Origin"] = corsOrigin;
  res.writeHead(status, headers);
  res.end(body);
}

export function sendError(res: ServerResponse, message: string, status = 500, corsOrigin?: string): void {
  sendJson(res, { error: message }, status, corsOrigin);
}

// ---------------------------------------------------------------------------
// Request body reading
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 1024 * 1024; // 1MB

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body exceeds 1MB limit"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// CORS
// ---------------------------------------------------------------------------

/** Resolve the allowed CORS origin for a request, given the server's allowlist. */
export function getAllowedOrigin(req: IncomingMessage, corsOrigins: ReadonlySet<string>): string | undefined {
  if (corsOrigins.size === 0) return undefined;
  const origin = req.headers.origin;
  if (!origin) return undefined;
  return corsOrigins.has(origin) ? origin : undefined;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  staticDir: string,
): Promise<void> {
  const { readFile } = await import("node:fs/promises");

  let urlPath = req.url?.split("?")[0] ?? "/";
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = resolve(join(staticDir, urlPath));
  const resolvedStaticDir = resolve(staticDir);
  if (!filePath.startsWith(resolvedStaticDir + "/")) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }

  try {
    const data = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    // SPA fallback — serve index.html
    try {
      const data = await readFile(join(staticDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
    }
  }
}

// ---------------------------------------------------------------------------
// TTL cache for read-only endpoints
// ---------------------------------------------------------------------------

interface CacheEntry { data: unknown; expires: number }
const apiCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export function cacheGet(key: string): unknown {
  const entry = apiCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expires) { apiCache.delete(key); return undefined; }
  return entry.data;
}

export function cacheSet(key: string, data: unknown): void {
  apiCache.set(key, { data, expires: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// Edge kind validation
// ---------------------------------------------------------------------------

export const VALID_EDGE_KINDS = new Set<string>(["calls", "imports", "extends", "implements", "depends-on", "contains", "service-call"]);
