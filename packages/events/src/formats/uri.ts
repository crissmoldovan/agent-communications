/**
 * The `uri` format: RFC 3986's `URI` — a scheme, then `:`, a hierarchical part and an optional query and fragment — as
 * JSON Schema 2020-12 reads it. A relative reference, a malformed percent-encoding and any non-ASCII character are
 * refused. A URI here carries no domain or date semantics (design D5).
 */

const isAlpha = (code: number) => (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
const isDigit = (code: number) => code >= 0x30 && code <= 0x39;
const isHex = (code: number) => isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
const UNRESERVED_MARKS = '-._~';
const SUB_DELIMS = "!$&'()*+,;=";

const isUnreserved = (character: string) =>
  isAlpha(character.charCodeAt(0)) || isDigit(character.charCodeAt(0)) || UNRESERVED_MARKS.includes(character);

/**
 * Whether every character of `text` is unreserved, a sub-delimiter, one of `extra`, or a well-formed `%XX`.
 * `text` holds no `#`, `?` or `/` it should not: callers split on those first.
 */
function allowed(text: string, extra: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const character = text[i] as string;
    if (character === '%') {
      if (!isHex(text.charCodeAt(i + 1)) || !isHex(text.charCodeAt(i + 2))) return false;
      i += 2;
    } else if (!isUnreserved(character) && !SUB_DELIMS.includes(character) && !extra.includes(character)) {
      return false;
    }
  }
  return true;
}

/** `h16`: one to four hexadecimal digits. */
const isH16 = (text: string) => text.length >= 1 && text.length <= 4 && [...text].every((c) => isHex(c.charCodeAt(0)));

/** `IPv4address`: four `dec-octet`s, 0–255 with no leading zero. */
function isIpv4(text: string): boolean {
  const parts = text.split('.');
  return (
    parts.length === 4 &&
    parts.every(
      (part) =>
        part.length >= 1 &&
        part.length <= 3 &&
        [...part].every((c) => isDigit(c.charCodeAt(0))) &&
        (part.length === 1 || part[0] !== '0') &&
        Number(part) <= 255,
    )
  );
}

/** `IPv6address`: eight 16-bit groups, the last two possibly an IPv4 address, at most one `::` standing for one or more. */
function isIpv6(text: string): boolean {
  const halves = text.split('::');
  if (halves.length > 2) return false;
  const groups = (half: string): string[] => (half === '' ? [] : half.split(':'));
  const all = [...groups(halves[0] as string), ...(halves.length === 2 ? groups(halves[1] as string) : [])];
  let count = 0;
  for (const [index, group] of all.entries()) {
    if (index === all.length - 1 && group.includes('.')) {
      if (!isIpv4(group)) return false;
      count += 2;
    } else if (isH16(group)) {
      count += 1;
    } else {
      return false;
    }
  }
  return halves.length === 2 ? count <= 7 : count === 8;
}

/** `IP-literal`'s inside: an IPv6 address, or `IPvFuture` (`v`, hex digits, `.`, then unreserved, sub-delims, `:`). */
function isIpLiteral(text: string): boolean {
  if (text[0] === 'v' || text[0] === 'V') {
    const dot = text.indexOf('.');
    if (dot < 2) return false;
    const version = text.slice(1, dot);
    const rest = text.slice(dot + 1);
    const hex = [...version].every((c) => isHex(c.charCodeAt(0)));
    return hex && rest !== '' && !rest.includes('%') && allowed(rest, ':');
  }
  return isIpv6(text);
}

/** `authority`: `[ userinfo "@" ] host [ ":" port ]`. */
function isAuthority(text: string): boolean {
  const at = text.lastIndexOf('@');
  if (at !== -1 && !allowed(text.slice(0, at), ':')) return false;
  const hostPort = at === -1 ? text : text.slice(at + 1);
  let host = hostPort;
  let port = '';
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    if (close === -1 || !isIpLiteral(hostPort.slice(1, close))) return false;
    const after = hostPort.slice(close + 1);
    if (after !== '' && !after.startsWith(':')) return false;
    host = hostPort.slice(0, close + 1);
    port = after.slice(1);
  } else {
    const colon = hostPort.lastIndexOf(':');
    if (colon !== -1) {
      host = hostPort.slice(0, colon);
      port = hostPort.slice(colon + 1);
    }
    // `reg-name`, which also covers every IPv4 address.
    if (!allowed(host, '')) return false;
  }
  return [...port].every((c) => isDigit(c.charCodeAt(0)));
}

/** A path's segments: `pchar`s (unreserved, pct-encoded, sub-delims, `:` and `@`) between slashes. */
const isPath = (text: string) => text.split('/').every((segment) => allowed(segment, ':@'));

/** Whether `value` is an RFC 3986 URI. */
export function isUri(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ), then ":".
  const colon = value.indexOf(':');
  if (colon < 1 || !isAlpha(value.charCodeAt(0))) return false;
  for (let i = 1; i < colon; i += 1) {
    const code = value.charCodeAt(i);
    if (!isAlpha(code) && !isDigit(code) && code !== 0x2b && code !== 0x2d && code !== 0x2e) return false;
  }
  let rest = value.slice(colon + 1);
  const hash = rest.indexOf('#');
  if (hash !== -1) {
    if (!allowed(rest.slice(hash + 1), ':@/?')) return false;
    rest = rest.slice(0, hash);
  }
  const question = rest.indexOf('?');
  if (question !== -1) {
    if (!allowed(rest.slice(question + 1), ':@/?')) return false;
    rest = rest.slice(0, question);
  }
  if (rest.startsWith('//')) {
    const slash = rest.indexOf('/', 2);
    const authority = slash === -1 ? rest.slice(2) : rest.slice(2, slash);
    const path = slash === -1 ? '' : rest.slice(slash);
    return isAuthority(authority) && isPath(path);
  }
  // path-absolute, path-rootless or path-empty; a path-absolute may not begin with "//", which was taken above.
  return isPath(rest);
}
