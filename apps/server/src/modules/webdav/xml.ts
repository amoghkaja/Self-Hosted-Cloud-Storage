/** Minimal WebDAV (RFC 4918) XML rendering. We only ever emit XML; request bodies are ignored. */

export function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === '"' ? '&quot;' : '&apos;',
  );
}

export interface DavEntry {
  href: string;
  displayName: string;
  collection: boolean;
  size?: number;
  contentType?: string | null;
  modified: Date;
  created: Date;
  etag: string;
  quota?: { used: number; available: number };
}

const SUPPORTED_LOCK =
  '<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>';

export function responseXml(e: DavEntry): string {
  const props = [
    `<D:displayname>${xmlEscape(e.displayName)}</D:displayname>`,
    e.collection ? '<D:resourcetype><D:collection/></D:resourcetype>' : '<D:resourcetype/>',
    `<D:getlastmodified>${e.modified.toUTCString()}</D:getlastmodified>`,
    `<D:creationdate>${e.created.toISOString()}</D:creationdate>`,
    `<D:getetag>${xmlEscape(e.etag)}</D:getetag>`,
    SUPPORTED_LOCK,
    '<D:lockdiscovery/>',
  ];
  if (!e.collection) {
    props.push(`<D:getcontentlength>${e.size ?? 0}</D:getcontentlength>`);
    props.push(
      `<D:getcontenttype>${xmlEscape(e.contentType ?? 'application/octet-stream')}</D:getcontenttype>`,
    );
  }
  if (e.quota) {
    // RFC 4331: lets Finder / Files show "x GB available".
    props.push(`<D:quota-used-bytes>${e.quota.used}</D:quota-used-bytes>`);
    props.push(
      `<D:quota-available-bytes>${Math.max(0, e.quota.available)}</D:quota-available-bytes>`,
    );
  }
  return `<D:response><D:href>${xmlEscape(e.href)}</D:href><D:propstat><D:prop>${props.join('')}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

export function multistatus(responses: string[]): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`;
}

/** PROPPATCH: we don't store dead properties, but acknowledge them so clients (Windows, Finder) proceed. */
export function proppatchXml(href: string): string {
  return multistatus([
    `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop/><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
  ]);
}

export function lockXml(href: string, token: string, owner: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>\n<D:prop xmlns:D="DAV:"><D:lockdiscovery><D:activelock><D:locktype><D:write/></D:locktype><D:lockscope><D:exclusive/></D:lockscope><D:depth>infinity</D:depth><D:owner>${xmlEscape(owner)}</D:owner><D:timeout>Second-3600</D:timeout><D:locktoken><D:href>${token}</D:href></D:locktoken><D:lockroot><D:href>${xmlEscape(href)}</D:href></D:lockroot></D:activelock></D:lockdiscovery></D:prop>`;
}

/** Encodes path segments into an href under /dav/. */
export function davHref(segments: string[], collection: boolean): string {
  const path = segments.map((s) => encodeURIComponent(s)).join('/');
  if (segments.length === 0) return '/dav/';
  return `/dav/${path}${collection ? '/' : ''}`;
}
