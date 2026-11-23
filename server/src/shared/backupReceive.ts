export const BACKUP_CHUNK_SIZE = 512 * 1024;

export function isLocalBackupHost(host: string): boolean {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const octets = host.split('.').map(Number);
  if (octets.some((part) => part > 255)) return false;
  const [first, second] = octets;
  return first === 10 || first === 127 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 169 && second === 254) ||
    (first === 100 && second >= 64 && second <= 127);
}

export function parseBackupReceiveUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !isLocalBackupHost(url.hostname)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    return /^\/api\/transfer\/backup\/[a-f0-9]{32}$/.test(url.pathname) ? url : null;
  } catch {
    return null;
  }
}
