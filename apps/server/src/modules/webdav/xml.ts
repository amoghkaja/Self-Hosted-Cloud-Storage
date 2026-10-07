/** Minimal WebDAV (RFC 4918) XML rendering. We only ever emit XML; request bodies are ignored. */

/**
 * Characters XML 1.0 can't hold (controls, lone surrogates, U+FFFE/U+FFFF). One in a display name
 * (shared folders show their owner's) or in a name stored before names refused them would make a
 * client reject the whole listing. Hrefs are percent-encoded, so the file can still be reached.
 */
const NOT_IN_XML = /[^\t\n\r\x20-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu;

export function xmlEscape(s: string): string {
  return s
    .replace(NOT_IN_XML, '\uFFFD')
    .replace(/[<>&"']/g, (c) =>
      c === '<'
        ? '&lt;'
        : c === '>'
          ? '&gt;'
          : c === '&'
            ? '&amp;'
            : c === '"'
              ? '&quot;'
              : '&apos;',
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

export const MULTISTATUS_HEAD =
  '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">';
export const MULTISTATUS_TAIL = '</D:multistatus>';

export function multistatus(responses: string[]): string {
  return MULTISTATUS_HEAD + responses.join('') + MULTISTATUS_TAIL;
}

export interface PropName {
  ns: string;
  name: string;
}

const NAME = '[A-Za-z_][\\w.-]*';
const TAG = new RegExp(
  `<(/?)((?:${NAME}:)?${NAME})((?:\\s+[^\\s=/>]+\\s*=\\s*(?:"[^"]*"|'[^']*'))*)\\s*(/?)>`,
  'g',
);
const XMLNS = /\s(xmlns(?::([^\s=]+))?)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Properties a PROPPATCH body sets or removes. A deliberately small scanner (no DTDs or
 * entities): it only needs element names and the namespaces they resolve to.
 */
export function proppatchNames(xml: string): PropName[] {
  // An unclosed comment or declaration runs to the end. Searching for its end again from every
  // "<" after it made a 64 KB body of "<!--<!--…" hold up the server for half a second.
  const clean = xml.replace(
    /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<[?!][^>]*>?/g,
    '',
  );
  const stack: { ns: string; name: string; scope: Map<string, string> }[] = [];
  const out: PropName[] = [];
  for (const m of clean.matchAll(TAG)) {
    const [, closing, qname = '', attrs = '', selfClosing] = m;
    if (closing) {
      stack.pop();
      continue;
    }
    const scope = new Map(stack.at(-1)?.scope);
    for (const a of attrs.matchAll(XMLNS)) scope.set(a[2] ?? '', a[3] ?? a[4] ?? '');
    const colon = qname.indexOf(':');
    const el = {
      ns: scope.get(colon < 0 ? '' : qname.slice(0, colon)) ?? '',
      name: colon < 0 ? qname : qname.slice(colon + 1),
      scope,
    };
    const [update, prop] = [stack.at(-2), stack.at(-1)];
    if (
      prop?.ns === 'DAV:' &&
      prop.name === 'prop' &&
      update?.ns === 'DAV:' &&
      (update.name === 'set' || update.name === 'remove') &&
      out.length < 100
    ) {
      out.push({ ns: el.ns, name: el.name });
    }
    if (!selfClosing) stack.push(el);
  }
  return out;
}

/**
 * PROPPATCH: we don't store dead properties, but acknowledge each one (RFC 4918 wants a
 * propstat per property) so clients such as Windows Explorer, which sets its Win32 times after
 * every upload, proceed.
 */
export function proppatchXml(href: string, props: PropName[]): string {
  const names = props
    .map((p, i) =>
      p.ns === 'DAV:'
        ? `<D:${p.name}/>`
        : p.ns
          ? `<x${i}:${p.name} xmlns:x${i}="${xmlEscape(p.ns)}"/>`
          : `<${p.name} xmlns=""/>`,
    )
    .join('');
  return multistatus([
    `<D:response><D:href>${xmlEscape(href)}</D:href><D:propstat><D:prop>${names}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`,
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
