/**
 * Extracts the integrator type from a file path.
 * Matches `clients/{type}/` in the path.
 * For vendor paths `clients/{type}/vendors/{vendor}/`, returns the vendor type.
 */

const VENDOR_PATH_RE = /(?:^|[/\\])clients[/\\]([^/\\]+)[/\\]vendors[/\\]([^/\\]+)[/\\]/;
const BASE_PATH_RE = /(?:^|[/\\])clients[/\\]([^/\\]+)[/\\]/;
const ROOT_FILE_RE = /(?:^|[/\\])clients[/\\]([^/\\]+)\.[jt]sx?$/;

export function extractIntegratorTypeFromPath(filePath: string): string | undefined {
  const vendorMatch = VENDOR_PATH_RE.exec(filePath);
  if (vendorMatch) {
    return vendorMatch[2];
  }
  const baseMatch = BASE_PATH_RE.exec(filePath);
  if (baseMatch) {
    return baseMatch[1];
  }
  const rootFileMatch = ROOT_FILE_RE.exec(filePath);
  if (rootFileMatch) {
    return rootFileMatch[1];
  }
  return undefined;
}
