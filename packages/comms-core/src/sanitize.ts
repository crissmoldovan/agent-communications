import render from 'dom-serializer';
import { type AnyNode, type ChildNode, type Element, isComment, isTag, isText } from 'domhandler';
import { convert } from 'html-to-text';
import { parseDocument } from 'htmlparser2';

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

// Zero-width and formatting characters, bidi controls, variation selectors and Unicode tag characters
// (U+E0000–U+E007F), as code-point ranges. Built with RegExp so no invisible character appears in this file.
const INVISIBLE_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad], // soft hyphen
  [0x034f, 0x034f], // combining grapheme joiner
  [0x061c, 0x061c], // Arabic letter mark
  [0x115f, 0x1160], // Hangul fillers
  [0x17b4, 0x17b5], // Khmer inherent vowels
  [0x180b, 0x180f], // Mongolian variation selectors and vowel separator
  [0x200b, 0x200f], // zero-width space/non-joiner/joiner, LRM, RLM
  [0x202a, 0x202e], // bidi embeddings and overrides
  [0x2060, 0x2064], // word joiner and invisible operators
  [0x2066, 0x206f], // bidi isolates and deprecated format characters
  [0x3164, 0x3164], // Hangul filler
  [0xfe00, 0xfe0f], // variation selectors
  [0xfeff, 0xfeff], // zero-width no-break space / BOM
  [0xffa0, 0xffa0], // halfwidth Hangul filler
  [0xe0000, 0xe007f], // Unicode tag characters
];
const INVISIBLE_CHARS = new RegExp(
  `[${INVISIBLE_RANGES.map(([from, to]) => (from === to ? `\\u{${from.toString(16)}}` : `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`)).join('')}]`,
  'gu',
);

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

function numeric(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^(-?\d*\.?\d+)\s*(px|pt|em|rem|%)?$/.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  switch (match[2]) {
    case 'pt':
      return amount * (4 / 3);
    case 'em':
    case 'rem':
      return amount * 16;
    case '%':
      return amount * 0.16;
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
  const fontSize = numeric(style.get('font-size'));
  if (fontSize !== null && fontSize <= 1) return true;
  if (style.get('color') === 'transparent') return true;
  const overflowHidden = (style.get('overflow') ?? style.get('overflow-y') ?? '').includes('hidden');
  for (const dimension of ['max-height', 'height', 'max-width', 'width']) {
    const size = numeric(style.get(dimension));
    if (size !== null && size <= 1 && overflowHidden) return true;
  }
  const clip = style.get('clip') ?? '';
  if (/rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)/.test(clip)) return true;
  const clipPath = style.get('clip-path') ?? '';
  if (/inset\(\s*(50|100)%/.test(clipPath) || /circle\(\s*0/.test(clipPath)) return true;
  const indent = numeric(style.get('text-indent'));
  if (indent !== null && indent <= -500) return true;
  const position = style.get('position');
  if (position === 'absolute' || position === 'fixed') {
    for (const side of ['left', 'top', 'right', 'bottom']) {
      const offset = numeric(style.get(side));
      if (offset !== null && offset <= -500) return true;
    }
  }
  const transform = style.get('transform') ?? '';
  if (/scale\(\s*0(\.0+)?\s*[,)]/.test(transform)) return true;
  return false;
}

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
  const named: Record<string, string> = { white: '#ffffff', black: '#000000' };
  return named[v] ?? null;
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

function registrable(host: string): string {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
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

/** Strips zero-width, bidi-control and tag characters; returns the text and how many were removed. */
export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const cleaned = text.replace(INVISIBLE_CHARS, () => {
    removed += 1;
    return '';
  });
  return { text: cleaned, removed };
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
