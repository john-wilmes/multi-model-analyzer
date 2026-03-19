/**
 * Language-agnostic file classification for the parsing layer.
 *
 * classifyFileKind is implemented in @mma/core and re-exported here
 * for backwards compatibility.
 */

import type { FileKind } from "@mma/core";
export { classifyFileKind } from "@mma/core";

export function isParseable(kind: FileKind): boolean {
  return kind === "typescript" || kind === "javascript";
}
