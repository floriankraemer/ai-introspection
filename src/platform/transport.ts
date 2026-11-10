/** Host names of this machine, as a bind address or as a URL host (`[::1]`). */
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export const isLoopbackHost = (host: string): boolean => LOOPBACK.has(host);

/**
 * May secrets (tokens, credentials, session logs) travel to `url`? Yes over https; over plain http
 * only to this machine or when `allowHttp` is set. Any other scheme is refused.
 */
export function transportAllowed(url: URL, allowHttp: boolean): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && (allowHttp || isLoopbackHost(url.hostname));
}
