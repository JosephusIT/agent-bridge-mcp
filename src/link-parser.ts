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

export function parseSessionLink(raw: string): ParsedLink {
  const url = raw.startsWith('agentbridge://') ? raw.replace(/^agentbridge:/, 'https:') : raw;
  const parsed = new URL(url);

  if (parsed.protocol !== 'https:') {
    throw new Error('Invalid AgentBridge session link: server-url must use https://');
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
