import render from 'dom-serializer';
import { type AnyNode, type ChildNode, type Element, isComment, isTag, isText } from 'domhandler';
import { convert } from 'html-to-text';
import { parseDocument } from 'htmlparser2';
import { isDangerous } from './chars.ts';

/**
 * Email HTML is attacker-controlled. Before any of it becomes text a model reads, this removes what a human reading
 * the message in a mail client would not see — the channel used by hidden-text prompt injection (e.g. zero-size or
 * white-on-white instructions aimed at an assistant summarising the mail) — and reports what it removed, because
 * hidden text is itself a phishing signal.
 */

const DROP_TAGS = new Set([
  'script',
  'style',
  'head',
  'title',
  'template',
  'noscript',
  'iframe',
  'object',
  'embed',
  'meta',
  'link',
  'base',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'svg',
  'math',
]);

const URL_SHORTENERS = new Set([
  'bit.ly',
  'tinyurl.com',
  't.co',
  'goo.gl',
  'ow.ly',
  'is.gd',
  'buff.ly',
  'rebrand.ly',
  'cutt.ly',
  'shorturl.at',
  'rb.gy',
  't.ly',
  'lnkd.in',
  's.id',
  'tiny.cc',
]);

export type LinkFlag = 'text-domain-mismatch' | 'punycode' | 'ip-literal' | 'shortener' | 'non-http' | 'unparseable';

export interface SanitizedLink {
  text: string;
  domain: string | null;
  flags: LinkFlag[];
}

export interface SanitizeReport {
  /** Elements removed because a reader would not see them (hidden by style, attribute or stylesheet). */
  hiddenElements: number;
  /** Characters of text inside those elements. */
  hiddenChars: number;
  /** Elements whose text colour matches their background colour — flagged, not removed. */
  sameColorElements: number;
  /** Zero-width, bidi-control and Unicode tag characters stripped from the text. */
  invisibleCharsRemoved: number;
  links: SanitizedLink[];
  imagesNotLoaded: number;
}

export interface SanitizedText {
  text: string;
  report: SanitizeReport;
}

function emptyReport(): SanitizeReport {
  return {
    hiddenElements: 0,
    hiddenChars: 0,
    sameColorElements: 0,
    invisibleCharsRemoved: 0,
    links: [],
    imagesNotLoaded: 0,
  };
}

/** Parses an inline `style` attribute into lower-cased property → value. */
function parseStyle(style: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!style) return map;
  for (const declaration of style.split(';')) {
    const colon = declaration.indexOf(':');
    if (colon < 0) continue;
    const property = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .trim()
      .toLowerCase()
      .replace(/\s*!important$/, '');
    if (property) map.set(property, value);
  }
  return map;
}

/**
 * A nominal mail-reading viewport, so lengths in viewport units can be compared with the thresholds above. The exact
 * size does not matter: `left:-200vw` is off-screen at any plausible width, and `width:0vw` is nothing wide at every
 * width. What matters is that these units are understood at all — unparsed, they read as "no length", and an element
 * pushed off-screen with them would have been treated as visible.
 */
const VIEWPORT_WIDTH_PX = 1000;
const VIEWPORT_HEIGHT_PX = 800;
/** A percentage font size is relative to the parent's, which starts at the usual 16px default. */
const FONT_SIZE_BASIS_PX = 16;

/**
 * A percentage means different things in different properties: of the parent's font size for `font-size`, of the
 * containing block for `left`, `text-indent` and the rest. One factor cannot serve both — scaling a layout
 * percentage by the font-size basis made `text-indent:-200%` read as −32px, which is not off-screen, and the text
 * hidden that way reached the reader.
 */
function numeric(value: string | undefined, percentBasis: number = VIEWPORT_WIDTH_PX): number | null {
  if (value === undefined) return null;
  const match = /^(-?\d*\.?\d+)\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|%|vw|vh|vmin|vmax)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  switch ((match[2] ?? '').toLowerCase()) {
    case 'pt':
      return amount * (4 / 3);
    case 'pc':
      return amount * 16;
    case 'in':
      return amount * 96;
    case 'cm':
      return amount * 37.8;
    case 'mm':
      return amount * 3.78;
    case 'q':
      return amount * 0.945;
    case 'em':
    case 'rem':
      return amount * 16;
    case 'ex':
      return amount * 8;
    case 'ch':
      return amount * 8;
    case '%':
      return (amount * percentBasis) / 100;
    case 'vw':
      return (amount * VIEWPORT_WIDTH_PX) / 100;
    case 'vh':
      return (amount * VIEWPORT_HEIGHT_PX) / 100;
    case 'vmin':
      return (amount * Math.min(VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX)) / 100;
    case 'vmax':
      return (amount * Math.max(VIEWPORT_WIDTH_PX, VIEWPORT_HEIGHT_PX)) / 100;
    default:
      return amount;
  }
}

/** True when a set of declarations hides the element from a human reader. */
export function hidesContent(style: Map<string, string>): boolean {
  const display = style.get('display');
  if (display === 'none') return true;
  const visibility = style.get('visibility');
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (style.get('mso-hide') === 'all') return true;
  const opacity = style.get('opacity');
  if (opacity !== undefined && Number(opacity) <= 0.05) return true;
  const fontSize = numeric(style.get('font-size'), FONT_SIZE_BASIS_PX);
  if (fontSize !== null && fontSize <= 1) return true;
  // Invisible text: `transparent`, an alpha of zero in rgba()/hsla()/#RRGGBBAA, or a fill colour that erases it.
  if (isInvisibleColor(style.get('color')) || isInvisibleColor(style.get('-webkit-text-fill-color'))) return true;
  // Overflow is clipped per axis: a zero-width box needs `overflow-x` (or the shorthand) to hide its text, a
  // zero-height one needs `overflow-y`. Checking only the shorthand and the y axis let `overflow-x` through.
  const overflow = style.get('overflow') ?? '';
  const hiddenAcross = (axis: 'x' | 'y'): boolean =>
    overflow.includes('hidden') || (style.get(`overflow-${axis}`) ?? '').includes('hidden');
  for (const dimension of ['max-height', 'height', 'max-width', 'width']) {
    const vertical = dimension.endsWith('height');
    const size = numeric(style.get(dimension), vertical ? VIEWPORT_HEIGHT_PX : VIEWPORT_WIDTH_PX);
    if (size !== null && size <= 1 && hiddenAcross(vertical ? 'y' : 'x')) return true;
  }
  const clip = style.get('clip') ?? '';
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(clip)) return true;
  const clipPath = style.get('clip-path') ?? '';
  if (/inset\(\s*(50|100)%/.test(clipPath) || /circle\(\s*0/.test(clipPath)) return true;
  if (offScreen(numeric(style.get('text-indent')))) return true;
  for (const side of ['margin-left', 'margin-top']) {
    if (offScreen(numeric(style.get(side), side.endsWith('top') ? VIEWPORT_HEIGHT_PX : VIEWPORT_WIDTH_PX))) return true;
  }
  const position = style.get('position');
  if (position === 'absolute' || position === 'fixed' || position === 'relative') {
    // Far in either direction: a large positive left/top pushes content past the right or bottom edge just as a
    // large negative one pushes it past the left or top, and the same holds for right/bottom mirrored.
    for (const side of ['left', 'top', 'right', 'bottom']) {
      const vertical = side === 'top' || side === 'bottom';
      if (offScreen(numeric(style.get(side), vertical ? VIEWPORT_HEIGHT_PX : VIEWPORT_WIDTH_PX))) return true;
    }
  }
  const transform = style.get('transform') ?? '';
  if (/scale[xy]?\(\s*0(\.0+)?\s*[,)]/.test(transform)) return true;
  for (const match of transform.matchAll(/translate[xy3d]*\(([^)]*)\)/g)) {
    if ((match[1] ?? '').split(',').some((part) => offScreen(numeric(part)))) return true;
  }
  return false;
}

/** How far content must be pushed before no mail client shows it: past the start edge, or past the far edge. */
const OFF_SCREEN_BEFORE = 500;
const OFF_SCREEN_AFTER = 2000;

function offScreen(offset: number | null): boolean {
  return offset !== null && (offset <= -OFF_SCREEN_BEFORE || offset >= OFF_SCREEN_AFTER);
}

/** The alpha of a colour, or 1 when it carries none. Anything unparseable reads as opaque rather than as hidden. */
export function colorAlpha(value: string | undefined): number {
  if (!value) return 1;
  const text = value.trim().toLowerCase();
  if (text === 'transparent') return 0;
  // Every functional colour syntax that can carry an alpha, including CSS Level 4's `color()` family. The inner text
  // is taken to the last `)`, so a nested `calc(...)` does not cut the match short.
  const functional = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(([\s\S]*)\)$/.exec(text);
  if (functional) {
    const inner = (functional[1] ?? '').trim();
    // Both syntaxes: the comma form `rgba(0, 0, 0, 0)` and the modern slash form `rgb(0 0 0 / 0%)`.
    // The alpha follows the last top-level slash: `color(display-p3 0 0 0 / 0)`, `rgb(0 0 0 / calc(1 - 1))`.
    const slash = lastTopLevelSlash(inner);
    const alpha = slash >= 0 ? inner.slice(slash + 1).trim() : inner.split(',').map((part) => part.trim())[3];
    if (alpha === undefined || alpha === '') return 1;
    const percentage = alpha.endsWith('%');
    const amount = Number.parseFloat(percentage ? alpha.slice(0, -1) : alpha);
    if (!Number.isFinite(amount)) return 1;
    return percentage ? amount / 100 : amount;
  }
  const hex = /^#([0-9a-f]{4}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    const digits = hex[1] ?? '';
    const alpha = digits.length === 4 ? digits.slice(3).repeat(2) : digits.slice(6);
    return Number.parseInt(alpha, 16) / 255;
  }
  return 1;
}

/** The last `/` that is not inside parentheses, or -1. */
function lastTopLevelSlash(value: string): number {
  let depth = 0;
  let found = -1;
  for (let index = 0; index < value.length; index++) {
    const character = value[index];
    if (character === '(') depth++;
    else if (character === ')') depth--;
    else if (character === '/' && depth === 0) found = index;
  }
  return found;
}

/** True when text in this colour cannot be seen at all — the same bar as `opacity`. */
function isInvisibleColor(value: string | undefined): boolean {
  return value !== undefined && colorAlpha(value) <= 0.05;
}

/**
 * The CSS named colours that matter here: the near-whites and near-blacks people use to hide text against a
 * background. Not the full list of 148 — a colour nobody writes text in cannot hide it.
 */
const NAMED_COLORS: Record<string, string> = {
  white: '#ffffff',
  snow: '#fffafa',
  ivory: '#fffff0',
  ghostwhite: '#f8f8ff',
  floralwhite: '#fffaf0',
  seashell: '#fff5ee',
  whitesmoke: '#f5f5f5',
  aliceblue: '#f0f8ff',
  mintcream: '#f5fffa',
  azure: '#f0ffff',
  honeydew: '#f0fff0',
  linen: '#faf0e6',
  oldlace: '#fdf5e6',
  beige: '#f5f5dc',
  lavenderblush: '#fff0f5',
  cornsilk: '#fff8dc',
  black: '#000000',
  transparent: '#00000000',
};

function normaliseColor(value: string | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(v);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  if (/^#[0-9a-f]{6}$/.test(v)) return v;
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(v);
  if (rgb) {
    return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('')}`;
  }
  return NAMED_COLORS[v] ?? null;
}

interface StylesheetRules {
  hiddenClasses: Set<string>;
  hiddenIds: Set<string>;
  hiddenTags: Set<string>;
}

/** Collects simple selectors (`.class`, `#id`, `tag`, `tag.class`) whose declarations hide content. */
function hiddenSelectorsFromStylesheets(root: AnyNode): StylesheetRules {
  const rules: StylesheetRules = { hiddenClasses: new Set(), hiddenIds: new Set(), hiddenTags: new Set() };
  const visit = (node: AnyNode): void => {
    if (isTag(node) && node.name === 'style') {
      const css = node.children
        .filter(isText)
        .map((t) => t.data)
        .join('')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      for (const block of css.split('}')) {
        const brace = block.indexOf('{');
        if (brace < 0) continue;
        const selectors = block.slice(0, brace);
        if (selectors.includes('@')) continue;
        if (!hidesContent(parseStyle(block.slice(brace + 1)))) continue;
        for (const raw of selectors.split(',')) {
          const selector = raw.trim().toLowerCase();
          const match = /^([a-z][a-z0-9]*)?(?:([.#])([a-z0-9_-]+))?$/.exec(selector);
          if (!match) continue;
          const [, tag, kind, name] = match;
          if (kind === '.' && name) rules.hiddenClasses.add(name);
          else if (kind === '#' && name) rules.hiddenIds.add(name);
          else if (tag && !kind) rules.hiddenTags.add(tag);
        }
      }
    }
    if ('children' in node) for (const child of (node as Element).children) visit(child);
  };
  visit(root);
  return rules;
}

function textLength(node: AnyNode): number {
  if (isText(node)) return node.data.replace(/\s+/g, ' ').trim().length;
  if ('children' in node) return (node as Element).children.reduce((sum, child) => sum + textLength(child), 0);
  return 0;
}

function isHiddenElement(element: Element, rules: StylesheetRules): boolean {
  const attribs = element.attribs;
  if ('hidden' in attribs) return true;
  if ((attribs['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  if (rules.hiddenTags.has(element.name)) return true;
  if (attribs.id && rules.hiddenIds.has(attribs.id.toLowerCase())) return true;
  for (const cls of (attribs.class ?? '').toLowerCase().split(/\s+/)) {
    if (cls && rules.hiddenClasses.has(cls)) return true;
  }
  if (hidesContent(parseStyle(attribs.style))) return true;
  // <font size="1"> and smaller is still readable; only an explicit zero is hidden.
  if (element.name === 'font' && attribs.size !== undefined && Number(attribs.size) <= 0) return true;
  return false;
}

/** Removes hidden nodes in place and counts them. */
function prune(nodes: ChildNode[], rules: StylesheetRules, report: SanitizeReport): ChildNode[] {
  const kept: ChildNode[] = [];
  for (const node of nodes) {
    if (isComment(node)) continue;
    if (isText(node)) {
      // Strip before conversion: the converter treats a zero-width space as a word break.
      const stripped = stripInvisible(node.data);
      report.invisibleCharsRemoved += stripped.removed;
      node.data = stripped.text;
    }
    if (isTag(node)) {
      if (DROP_TAGS.has(node.name)) continue;
      if (isHiddenElement(node, rules)) {
        report.hiddenElements += 1;
        report.hiddenChars += textLength(node);
        continue;
      }
      const style = parseStyle(node.attribs.style);
      const color = normaliseColor(style.get('color'));
      const background = normaliseColor(style.get('background-color') ?? style.get('background'));
      if (color && background && color === background) report.sameColorElements += 1;
      node.children = prune(node.children, rules, report);
      for (const child of node.children) child.parent = node;
    }
    kept.push(node);
  }
  return kept;
}

function hostOf(href: string): { host: string | null; protocol: string | null } {
  try {
    const url = new URL(href);
    return { host: url.hostname.toLowerCase() || null, protocol: url.protocol };
  } catch {
    return { host: null, protocol: null };
  }
}

/**
 * Suffixes under which anyone can register, so the last two labels are not the owner. Not the full public suffix
 * list — that is a downloaded, versioned dataset — but enough that `attacker.co.uk` and `victim.co.uk` are not
 * treated as the same organisation, which silently suppressed the mismatch flag.
 */
const MULTI_LABEL_SUFFIXES = new Set([
  'co.uk',
  'org.uk',
  'me.uk',
  'ltd.uk',
  'plc.uk',
  'net.uk',
  'sch.uk',
  'ac.uk',
  'gov.uk',
  'com.au',
  'net.au',
  'org.au',
  'edu.au',
  'gov.au',
  'id.au',
  'co.nz',
  'net.nz',
  'org.nz',
  'govt.nz',
  'co.jp',
  'or.jp',
  'ne.jp',
  'ac.jp',
  'go.jp',
  'com.br',
  'com.cn',
  'com.hk',
  'com.sg',
  'com.tr',
  'com.mx',
  'com.ar',
  'com.tw',
  'co.za',
  'co.in',
  'co.kr',
  'co.il',
  'com.pl',
  'com.ua',
  'com.ph',
  'com.my',
  'com.vn',
  'com.eg',
  'com.sa',
  'github.io',
  'gitlab.io',
  'pages.dev',
  'workers.dev',
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'blogspot.com',
  'wordpress.com',
  'notion.site',
  'r2.dev',
  's3.amazonaws.com',
]);

function registrable(host: string): string {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const lastTwo = parts.slice(-2).join('.');
  return MULTI_LABEL_SUFFIXES.has(lastTwo) ? parts.slice(-3).join('.') : lastTwo;
}

/** Analyses one link as a human would see it: its visible text versus where it really goes. */
export function analyseLink(text: string, href: string): SanitizedLink {
  const flags: LinkFlag[] = [];
  const { host, protocol } = hostOf(href);
  if (!host) {
    if (protocol === 'mailto:') return { text, domain: href.slice(7).split('@')[1]?.split('?')[0] ?? null, flags };
    flags.push(protocol ? 'non-http' : 'unparseable');
    return { text, domain: null, flags };
  }
  if (protocol !== 'http:' && protocol !== 'https:') flags.push('non-http');
  if (host.split('.').some((label) => label.startsWith('xn--'))) flags.push('punycode');
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[')) flags.push('ip-literal');
  if (URL_SHORTENERS.has(host)) flags.push('shortener');
  const shown = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(text.replace(/^https?:\/\//i, ''));
  if (shown) {
    const shownHost = shown[0].toLowerCase();
    if (registrable(shownHost) !== registrable(host)) flags.push('text-domain-mismatch');
  }
  return { text, domain: host, flags };
}

/**
 * Strips control characters (ESC, CSI, OSC and the rest), DEL, lone carriage returns, zero-width, bidi-control and tag
 * characters from sender-controlled text; returns the text and how many were removed. CRLF becomes LF first.
 */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  let out = '';
  for (const char of text.replace(/\r\n/g, '\n')) {
    if (isDangerous(char.codePointAt(0) ?? 0)) removed += 1;
    else out += char;
  }
  return { text: out, removed };
}

/**
 * Converts email HTML to plain text for a model to read: hidden content removed, links rendered as
 * `text [domain]`, images never loaded, invisible characters stripped — with a report of everything removed.
 */
export function sanitizeHtmlToText(html: string, options: { wordwrap?: number | false } = {}): SanitizedText {
  const report = emptyReport();
  const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const rules = hiddenSelectorsFromStylesheets(document);
  document.children = prune(document.children, rules, report);
  const cleanedHtml = render(document, { decodeEntities: false });

  const text = convert(cleanedHtml, {
    wordwrap: options.wordwrap ?? false,
    selectors: [
      {
        selector: 'a',
        format: 'agentLink',
      },
      { selector: 'img', format: 'agentImage' },
    ],
    formatters: {
      agentLink: (elem, walk, builder) => {
        const href = (elem.attribs?.href ?? '').trim();
        walk(elem.children, builder);
        if (href) {
          const link = analyseLink(textOf(elem), href);
          report.links.push(link);
          const flagText = link.flags.length ? ` ${link.flags.join(' ')}` : '';
          builder.addInline(` [${link.domain ?? 'link'}${flagText}]`, { noWordTransform: true });
        }
      },
      agentImage: (elem, _walk, builder) => {
        report.imagesNotLoaded += 1;
        const alt = (elem.attribs?.alt ?? '').trim();
        builder.addInline(alt ? `[image: ${alt}, not loaded]` : '[image not loaded]', { noWordTransform: true });
      },
    },
  });
  // Entities decoded by the converter (e.g. &#8203;) can still produce invisible characters.
  const stripped = stripInvisible(text);
  report.invisibleCharsRemoved += stripped.removed;
  return { text: stripped.text.trim(), report };
}

interface TextNodeLike {
  children?: unknown[] | undefined;
  type?: string | undefined;
  data?: string | undefined;
}

function textOf(node: TextNodeLike): string {
  if (node.type === 'text') return node.data ?? '';
  const children = (node.children ?? []) as TextNodeLike[];
  return children.map(textOf).join('').replace(/\s+/g, ' ').trim();
}

/** Plain-text bodies get the same invisible-character treatment as HTML ones. */
export function sanitizePlainText(text: string): SanitizedText {
  const report = emptyReport();
  const stripped = stripInvisible(text);
  report.invisibleCharsRemoved = stripped.removed;
  return { text: stripped.text, report };
}

export interface OutboundHtmlReport {
  /** What a recipient sees, as text (hidden content removed) — compared with the draft's text part. */
  visibleText: string;
  /** Content a recipient would not see, with why; shown to the approver, never silently dropped. */
  hidden: { reason: string; text: string }[];
  /** Every URL in the HTML with its full query string, and where it appears. */
  urls: { where: string; url: string }[];
  /** URLs a mail client fetches on open — each one a potential beacon carrying data out. */
  remoteResources: string[];
  forms: number;
  scripts: number;
}

const URL_ATTRIBUTES = ['href', 'src', 'action', 'background', 'poster', 'data', 'formaction', 'cite', 'longdesc'];
const AUTO_LOADING = new Set([
  'img',
  'image',
  'iframe',
  'frame',
  'object',
  'embed',
  'video',
  'audio',
  'source',
  'track',
  'input',
]);
const FORM_TAGS = new Set(['form', 'input', 'button', 'select', 'textarea']);
const CSS_URL = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;

function isRemote(url: string): boolean {
  return /^(?:https?:)?\/\//i.test(url.trim());
}

/**
 * Analyses HTML an agent is about to send. The opposite of the inbound sanitiser: it shows hidden content instead of
 * dropping it, and lists every URL and every resource a mail client would load on open, so a preview cannot look
 * clean while the HTML carries a beacon or hidden text to the recipient.
 */
export function analyseOutboundHtml(html: string): OutboundHtmlReport {
  const document = parseDocument(html, { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true });
  const rules = hiddenSelectorsFromStylesheets(document);
  const report: OutboundHtmlReport = {
    visibleText: '',
    hidden: [],
    urls: [],
    remoteResources: [],
    forms: 0,
    scripts: 0,
  };
  const addUrl = (where: string, url: string, autoLoads: boolean): void => {
    const trimmed = url.trim();
    if (!trimmed) return;
    report.urls.push({ where, url: trimmed });
    if (autoLoads && isRemote(trimmed)) report.remoteResources.push(trimmed);
    if (/^\s*javascript:/i.test(trimmed)) report.scripts += 1;
  };
  const visit = (nodes: ChildNode[], hiddenAncestor: boolean): void => {
    for (const node of nodes) {
      if (isComment(node)) {
        if (node.data.trim()) report.hidden.push({ reason: 'comment', text: node.data.trim().slice(0, 500) });
        continue;
      }
      if (!isTag(node)) continue;
      const tag = node.name;
      if (tag === 'script') report.scripts += 1;
      if (FORM_TAGS.has(tag)) report.forms += 1;
      if (tag === 'style') {
        const css = node.children
          .filter(isText)
          .map((t) => t.data)
          .join('');
        for (const match of css.matchAll(CSS_URL)) addUrl('style block', match[2] ?? '', true);
        continue;
      }
      for (const [name, value] of Object.entries(node.attribs)) {
        if (name.startsWith('on')) report.scripts += 1;
        if (URL_ATTRIBUTES.includes(name)) {
          const autoLoads =
            name === 'background' ||
            (name === 'src' && AUTO_LOADING.has(tag)) ||
            (name === 'data' && tag === 'object') ||
            name === 'poster';
          addUrl(`${tag}[${name}]`, value, autoLoads || (tag === 'link' && name === 'href'));
        }
        if (name === 'srcset') {
          for (const candidate of value.split(','))
            addUrl(`${tag}[srcset]`, candidate.trim().split(/\s+/)[0] ?? '', true);
        }
        if (name === 'style')
          for (const match of value.matchAll(CSS_URL)) addUrl(`${tag}[style]`, match[2] ?? '', true);
      }
      let hidden = hiddenAncestor;
      if (!hiddenAncestor && (isHiddenElement(node, rules) || DROP_TAGS.has(tag))) {
        hidden = true;
        const text = textLength(node) > 0 ? textOfNode(node) : '';
        if (text || !DROP_TAGS.has(tag)) report.hidden.push({ reason: hiddenReason(node), text: text.slice(0, 500) });
      }
      visit(node.children, hidden);
    }
  };
  visit(document.children, false);
  report.visibleText = sanitizeHtmlToText(html).text;
  return report;
}

function textOfNode(node: AnyNode): string {
  if (isText(node)) return node.data;
  if ('children' in node) return (node as Element).children.map(textOfNode).join(' ').replace(/\s+/g, ' ').trim();
  return '';
}

function hiddenReason(element: Element): string {
  if (DROP_TAGS.has(element.name)) return `<${element.name}> is never shown`;
  if ('hidden' in element.attribs) return 'hidden attribute';
  if ((element.attribs['aria-hidden'] ?? '').toLowerCase() === 'true') return 'aria-hidden';
  if (element.attribs.style && hidesContent(parseStyle(element.attribs.style)))
    return `inline style: ${element.attribs.style.slice(0, 120)}`;
  return 'hidden by a stylesheet rule';
}
