/** Resolve app-owned paths for Sites (/) and a subdirectory deployment. */
export function appPath(path = '/'): string {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(path)) return path;

  const configuredBase = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  const base = `/${configuredBase.replace(/^\/+|\/+$/g, '')}`.replace(/\/+$/g, '') || '';
  const rootedPath = path.startsWith('/') ? path : `/${path}`;

  if (!base) return rootedPath;
  if (rootedPath === base) return `${base}/`;
  if (rootedPath.startsWith(`${base}/`) || rootedPath.startsWith(`${base}?`) || rootedPath.startsWith(`${base}#`)) return rootedPath;
  return `${base}${rootedPath}`;
}
