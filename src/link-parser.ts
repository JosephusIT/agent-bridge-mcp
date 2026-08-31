/** AgentBridge session link parser for contract links: https://host[:port]/s/{slug}?token=agt_... */

export interface ParsedLink {
  baseUrl: string;
  apiBaseUrl: string;
  slug: string;
  /** @deprecated use slug */
  sessionId: string;
  token?: string;
  params: Record<string, string>;
}

const SLUG_RE = /^[A-Za-z0-9-]{2,100}$/;
const TOKEN_RE = /^agt_[A-Za-z0-9_-]+$/;


/** Block session-link hosts that resolve to private/link-local/metadata ranges.
 * Localhost is allowed for local-dev only. */
function isBlockedNonLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
  // IPv4 private / link-local / metadata
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 0) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata 169.254.169.254
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  }
  // IPv6 unique-local / link-local
  if (host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80')) return true;
  // Common metadata hostnames
  if (host === 'metadata.google.internal' || host.endsWith('.internal')) return true;
  return false;
}

export function parseSessionLink(raw: string): ParsedLink {
  const url = raw.startsWith('agentbridge://') ? raw.replace(/^agentbridge:/, 'https:') : raw;
  const parsed = new URL(url);

  const host = parsed.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  if (parsed.protocol === 'http:') {
    if (!isLocal) {
      throw new Error(
        'Invalid AgentBridge session link: http:// is only allowed for localhost (use https:// for remote relays)'
      );
    }
  } else if (parsed.protocol !== 'https:') {
    throw new Error('Invalid AgentBridge session link: server-url must use https:// (or http://localhost)');
  }

  if (isBlockedNonLocalHost(host)) {
    throw new Error(
      `Invalid AgentBridge session link: host "${host}" is a private/link-local/metadata address; ` +
        'only localhost is allowed for non-public relays (SSRF protection)'
    );
  }

  const pathParts = parsed.pathname.replace(/^\/+/, '').split('/').filter(Boolean);
  const sessionIdx = pathParts.findIndex((part) => part === 's' || part === 'session');
  if (sessionIdx === -1 || !pathParts[sessionIdx + 1]) {
    throw new Error(`Invalid AgentBridge session link: missing /s/{slug} segment in "${raw}"`);
  }

  const slug = pathParts[sessionIdx + 1];
  if (!SLUG_RE.test(slug)) {
    throw new Error('Invalid AgentBridge session link: slug must be 2-100 letters, digits, or dashes');
  }

  const params: Record<string, string> = {};
  parsed.searchParams.forEach((v, k) => {
    params[k] = v;
  });

  const token = params.token;
  if (token !== undefined && !TOKEN_RE.test(token)) {
    throw new Error('Invalid AgentBridge session link: token must start with agt_ and contain only letters, digits, _ or -');
  }

  const baseUrl = `${parsed.protocol}//${parsed.host}`;
  return { baseUrl, apiBaseUrl: `${baseUrl}/api/v1`, slug, sessionId: slug, token, params };
}
