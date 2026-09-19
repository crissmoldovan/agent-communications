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
  /**
   * Hiding rules in a stylesheet that this parser could not apply to any element.
   *
   * Not zero means some text a mail client would have hidden is still in `text`. It is reported rather than guessed
   * at, because the two ways of guessing are both bad: applying such a rule to every element of a tag would gut a
   * legitimate message, and ignoring it silently is how hidden text reaches a model unannounced.
   */
  unreadableHidingRules: number;
}

export interface SanitizedText {
  text: string;
  report: SanitizeReport;
}

function emptyReport(): SanitizeReport {
  return {
    hiddenElements: 0,
    unreadableHidingRules: 0,
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
  // `calc()` first, and for the same reason it was handled for opacity: `font-size: calc(0px)` and
  // `text-indent: calc(-9999px)` hide text in every mail client, and a parser that gives up on the expression
  // reads them as "no size given" and keeps the element. Fixing one property and not the rest left the same
  // bypass standing behind a different declaration.
  const resolved = resolveCalc(value.trim(), percentBasis);
  const match = /^(-?\d*\.?\d+)\s*(px|pt|pc|in|cm|mm|q|em|rem|ex|ch|%|vw|vh|vmin|vmax)?$/i.exec(resolved);
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

/**
 * An alpha or opacity value as a number in 0–1: `0`, `0%`, `.04`, or a `calc()` this can evaluate.
 *
 * `Number('0%')` is `NaN`, which read as "not transparent" and let `opacity: 0%` — valid in every Chromium-based
 * mail client — hide text the sanitiser then handed to the model. `calc()` was the same gap wearing an expression:
 * anything unevaluated defaulted to opaque, so `calc(0 * 1)` hid text invisibly. Simple arithmetic is evaluated
 * here; anything more complicated still reads as opaque, because guessing the other way removes text a reader can
 * see.
 */
export function alphaValue(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const calc = /^calc\((.*)\)$/.exec(value);
  if (calc) {
    const evaluated = evaluateSimpleCalc(calc[1] ?? '');
    return evaluated;
  }
  if (value.endsWith('%')) {
    const percent = Number(value.slice(0, -1));
    return Number.isFinite(percent) ? percent / 100 : null;
  }
  const plain = Number(value);
  return Number.isFinite(plain) ? plain : null;
}

/** `0.5 * 0`, `100% - 100%`, `1/4` — two operands and one operator, which is what mail actually contains. */
function evaluateSimpleCalc(expression: string): number | null {
  const parsed = /^\s*([\d.]+%?)\s*([-+*/])\s*([\d.]+%?)\s*$/.exec(expression.trim());
  if (!parsed) {
    const single = /^\s*([\d.]+%?)\s*$/.exec(expression.trim());
    return single ? alphaValue(single[1]) : null;
  }
  const left = alphaValue(parsed[1]);
  const right = alphaValue(parsed[3]);
  if (left === null || right === null) return null;
  switch (parsed[2]) {
    case '+':
      return left + right;
    case '-':
      return left - right;
    case '*':
      return left * right;
    case '/':
      return right === 0 ? null : left / right;
    default:
      return null;
  }
}

/** The properties whose value decides whether an element is seen at all. */
const HIDING_PROPERTIES = [
  'display',
  'visibility',
  'opacity',
  'font-size',
  'color',
  '-webkit-text-fill-color',
  'width',
  'height',
  'max-width',
  'max-height',
  'clip',
  'clip-path',
  'text-indent',
  'transform',
  'position',
  'left',
  'top',
  'right',
  'bottom',
  'margin-left',
  'margin-top',
] as const;

/**
 * Whether a declaration hides the element through a custom property this cannot resolve.
 *
 * `<style>:root{--h:none}</style><div style="display:var(--h)">…</div>` renders as hidden in Gmail, Outlook 365 and
 * Apple Mail, and read as a plain string `display: var(--h)` is simply not `none` — so the element was kept and the
 * text inside it reached the model with nothing said. Resolving custom properties would mean implementing the
 * cascade; counting them does not, and it turns a silent miss into a number the reader can see.
 */
export function usesUnresolvedVariable(style: Map<string, string>): boolean {
  return HIDING_PROPERTIES.some((property) => /var\(/i.test(style.get(property) ?? ''));
}

/**
 * Evaluates a `calc()` simple enough to be sure of, and hands back a plain length for `numeric` to read.
 *
 * Two operands and one operator, both in the same unit — which is what mail actually contains. Anything else is
 * returned unchanged, so it falls through to the ordinary parse and, failing that, reads as "no value", which
 * keeps the element. Guessing in the other direction removes text a reader can see.
 */
function resolveCalc(value: string, percentBasis: number): string {
  const calc = /^calc\(([^()]*)\)$/i.exec(value);
  if (!calc) return value;
  const body = (calc[1] ?? '').trim();
  const single = /^(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(body);
  if (single) return body;
  const pair = /^(-?\d*\.?\d+)\s*([a-z%]*)\s*([-+*/])\s*(-?\d*\.?\d+)\s*([a-z%]*)$/i.exec(body);
  if (!pair) return value;
  const [, leftAmount, leftUnit, operator, rightAmount, rightUnit] = pair;
  const left = numeric(`${leftAmount}${leftUnit}`, percentBasis);
  const right = numeric(`${rightAmount}${rightUnit}`, percentBasis);
  if (left === null || right === null) return value;
  switch (operator) {
    case '+':
      return `${left + right}px`;
    case '-':
      return `${left - right}px`;
    case '*':
      // A multiplication has one unitless side in valid CSS; either way the pixel product is what matters here.
      return `${(leftUnit ? left : Number(leftAmount)) * (rightUnit ? right : Number(rightAmount))}px`;
    case '/':
      return Number(rightAmount) === 0 ? value : `${left / Number(rightAmount)}px`;
    default:
      return value;
  }
}

/** True when a set of declarations hides the element from a human reader. */
export function hidesContent(style: Map<string, string>): boolean {
  const display = style.get('display');
  if (display === 'none') return true;
  const visibility = style.get('visibility');
  if (visibility === 'hidden' || visibility === 'collapse') return true;
  if (style.get('mso-hide') === 'all') return true;
  const opacity = alphaValue(style.get('opacity'));
  if (opacity !== null && opacity <= 0.05) return true;
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
  // `polygon(0 0, 0 0, 0 0)` and the like: a shape with no area shows nothing.
  if (/ellipse\(\s*0(?:px|%|em|rem)?[\s,]/.test(clipPath) || /ellipse\(\s*0(?:px|%|em|rem)?\s*\)/.test(clipPath)) {
    return true;
  }
  const polygon = /polygon\(([^)]*)\)/.exec(clipPath);
  if (polygon && /^[\s,]*(?:0(?:px|%|em|rem)?[\s,]+0(?:px|%|em|rem)?[\s,]*)+$/.test(polygon[1] ?? 'x')) return true;
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
  // `[^)]*` stops at the first `)`, which is inside the argument when it is a `calc()` — so `translateX(calc(-9999px))`
  // yielded `calc(-9999px` and parsed as nothing. Balanced to one level, which is as deep as a transform goes.
  for (const match of transform.matchAll(/translate[xy3d]*\(((?:[^()]|\([^()]*\))*)\)/g)) {
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
    // Through the same reader the `opacity` property uses, so `rgba(0,0,0,calc(0))` and `rgb(0 0 0 / 0%)` are read
    // the same way. Anything it cannot evaluate still reads as opaque.
    const amount = alphaValue(alpha);
    return amount === null ? 1 : amount;
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
  // The rest of the CSS named colours. Same-colour-on-same-colour is flagged rather than removed, so the cost of a
  // name missing from this table is a warning the reader never sees — `cornsilk` on `cornsilk` reading as ordinary
  // text. The list is finite; carrying it is cheaper than explaining which names are covered.
  aqua: '#00ffff',
  aquamarine: '#7fffd4',
  bisque: '#ffe4c4',
  blanchedalmond: '#ffebcd',
  blue: '#0000ff',
  chartreuse: '#7fff00',
  coral: '#ff7f50',
  cyan: '#00ffff',
  darkgray: '#a9a9a9',
  darkgrey: '#a9a9a9',
  fuchsia: '#ff00ff',
  gainsboro: '#dcdcdc',
  gold: '#ffd700',
  gray: '#808080',
  green: '#008000',
  grey: '#808080',
  khaki: '#f0e68c',
  lavender: '#e6e6fa',
  lemonchiffon: '#fffacd',
  lightcyan: '#e0ffff',
  lightgoldenrodyellow: '#fafad2',
  lightgray: '#d3d3d3',
  lightgrey: '#d3d3d3',
  lightpink: '#ffb6c1',
  lightskyblue: '#87cefa',
  lightsteelblue: '#b0c4de',
  lightyellow: '#ffffe0',
  lime: '#00ff00',
  magenta: '#ff00ff',
  mistyrose: '#ffe4e1',
  moccasin: '#ffe4b5',
  navajowhite: '#ffdead',
  orange: '#ffa500',
  orchid: '#da70d6',
  palegoldenrod: '#eee8aa',
  paleturquoise: '#afeeee',
  papayawhip: '#ffefd5',
  peachpuff: '#ffdab9',
  pink: '#ffc0cb',
  plum: '#dda0dd',
  powderblue: '#b0e0e6',
  red: '#ff0000',
  silver: '#c0c0c0',
  skyblue: '#87ceeb',
  thistle: '#d8bfd8',
  wheat: '#f5deb3',
  yellow: '#ffff00',
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

/**
 * A rule that hides whatever it matches. `classes` must all be present, which is what makes `.a.b` different from
 * `.a` — the first hides only elements carrying both.
 */
interface HidingRule {
  tag: string | null;
  id: string | null;
  classes: string[];
  /** `[data-x]`, `[data-x="y"]`, `[class~="y"]` and the other comparisons CSS allows. */
  attributes: Array<{ name: string; operator: string; value: string }>;
}

interface StylesheetRules {
  rules: HidingRule[];
  /** Hiding rules whose selector this parser could not turn into a match. */
  unreadable: number;
}

/** A rule that only applies while the reader is doing something hides nothing in a message they simply open. */
const INTERACTION_PSEUDO = /:(?:hover|focus(?:-within|-visible)?|active|visited|target|checked)\b/;

/**
 * Removes pseudo-classes and pseudo-elements from a compound selector, brackets balanced.
 *
 * `:not(.a:has(> .b))` nests, so the argument is skipped by counting parentheses rather than by a regex, which
 * would stop at the first `)` and leave `)` behind for the compound walker to choke on.
 */
function stripPseudo(compound: string): string {
  let out = '';
  let index = 0;
  while (index < compound.length) {
    if (compound[index] !== ':') {
      out += compound[index];
      index++;
      continue;
    }
    index++;
    if (compound[index] === ':') index++; // a pseudo-element, `::before`
    while (index < compound.length && /[\w-]/.test(compound[index] ?? '')) index++;
    if (compound[index] === '(') {
      let depth = 0;
      do {
        if (compound[index] === '(') depth++;
        else if (compound[index] === ')') depth--;
        index++;
      } while (index < compound.length && depth > 0);
    }
  }
  return out;
}

/**
 * The part of a selector that says which element is hidden: the last compound, after any combinator. In
 * `.wrapper > .secret`, `.wrapper` is context and `.secret` is what disappears — marking both would remove content
 * the reader can see.
 */
export function parseHidingSelector(selector: string): HidingRule | null {
  const cleaned = selector.trim().toLowerCase();
  if (!cleaned || INTERACTION_PSEUDO.test(cleaned)) return null;
  // Pseudo-classes come off before the selector is split on its combinators, because their arguments contain
  // combinator characters: `:nth-child(2n+1)` split on `+` leaves `1)` as the subject, which parses as nothing.
  const withoutPseudo = stripPseudo(cleaned);
  const hadPseudo = withoutPseudo !== cleaned;
  const subject = withoutPseudo
    .split(/[\s>+~]+/)
    .filter(Boolean)
    .at(-1);
  if (!subject || subject === '*') return null;

  const rule: HidingRule = { tag: null, id: null, classes: [], attributes: [] };
  /**
   * Walk the compound: `div#id.a.b[attr]`.
   *
   * Structural pseudo-classes and pseudo-elements are **dropped rather than refused**, so long as what is left
   * still names something specific. `.inject:first-child{display:none}` is a rule Gmail and Outlook both apply, and
   * declining it because of the `:first-child` let the hidden text reach the model. Dropping the pseudo-class
   * widens the rule: it can hide an element CSS would have left visible, which costs a reader a line, where the
   * other direction costs them an undetected injection.
   *
   * What is *not* done is widen a compound that reduces to a bare tag. `p:not(.intro){display:none}` would become
   * "hide every paragraph", which destroys an ordinary message — so that one is declined and **counted**, and the
   * report says how many rules could not be read. Interaction pseudo-classes are refused above, because `:hover`
   * hides nothing when a message is opened.
   */
  const pattern = /^([a-z][\w-]*)|\.([\w-]+)|#([\w-]+)|\[([^\]]*)\]/;
  let rest = subject;
  let first = true;
  while (rest.length > 0) {
    const match = pattern.exec(rest);
    if (!match) return null;
    if (match[1] !== undefined) {
      if (!first) return null;
      rule.tag = match[1];
    } else if (match[2] !== undefined) {
      rule.classes.push(match[2]);
    } else if (match[3] !== undefined) {
      rule.id = match[3];
    } else if (match[4] !== undefined) {
      const attribute = /^\s*([\w-]+)\s*(?:([~^$*|]?=)\s*"?([^"\]]*)"?)?\s*$/.exec(match[4]);
      if (!attribute?.[1]) return null;
      rule.attributes.push({
        name: attribute[1].toLowerCase(),
        operator: attribute[2] ?? '',
        value: attribute[3] ?? '',
      });
    }
    rest = rest.slice(match[0].length);
    first = false;
  }
  const specific = Boolean(rule.id) || rule.classes.length > 0 || rule.attributes.length > 0;
  if (hadPseudo && !specific) return null;
  return specific || rule.tag ? rule : null;
}

/** Collects simple selectors (`.class`, `#id`, `tag`, `tag.class`) whose declarations hide content. */
/** At-rules whose body is ordinary rules that still apply when the message is opened. */
const NESTING_AT_RULES = /^@(media|supports|layer|container|scope|document)\b/i;

/**
 * If the next thing in the stylesheet ends with `;` rather than a block, returns where it ends; otherwise null.
 *
 * Quotes and brackets are tracked because a semicolon inside them is part of a value, not the end of a statement:
 * `@import url("a;b.css");` is one statement, and `@import "x"; .hide{display:none}` is two.
 */
function endOfStatement(css: string, from: number): number | null {
  let quote: string | null = null;
  let depth = 0;
  for (let index = from; index < css.length; index++) {
    const character = css[index];
    if (quote) {
      if (character === '\\') index++;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") quote = character;
    else if (character === '(' || character === '[') depth++;
    else if (character === ')' || character === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && character === '{') return null;
    else if (depth === 0 && character === ';') return index + 1;
  }
  return null;
}

/**
 * Whether a media query applies **only** on paper, in which case what it hides is still visible on screen.
 *
 * `not print` is the trap: it reads as a print query and means the opposite — everything except print, which very
 * much includes the screen. So a negated query is never print-only, and neither is one that also names `screen`,
 * `all`, or a feature every medium has.
 */
function isPrintOnly(prelude: string): boolean {
  if (!/@media\b/i.test(prelude)) return false;
  const query = prelude.replace(/^\s*@media\s*/i, '');
  // Any comma-separated alternative that is not print-only makes the whole query apply somewhere else too.
  return query
    .split(',')
    .every((part) => /\bprint\b/i.test(part) && !/\bnot\b/i.test(part) && !/\b(screen|all|speech)\b/i.test(part));
}

/**
 * Walks a stylesheet rule by rule, descending into `@media` and friends.
 *
 * Splitting on `}` and skipping anything containing `@` — which is what this did — means every rule inside a
 * `@media screen` or `@supports` block is ignored, and text hidden by one of them reaches the reader. Only a
 * print-only block is genuinely irrelevant: what it hides is still visible on screen, which is where mail is read.
 */
export function eachStyleRule(
  css: string,
  visit: (selectors: string, declarations: string) => void,
  unreadable: { count: number } = { count: 0 },
): void {
  let index = 0;
  while (index < css.length) {
    // Find where this rule's prelude ends. A `;` before the `{` ends a statement that has no block at all — `@import`,
    // `@charset`, `@namespace`, or a stray semicolon. Taking everything up to the next `{` instead would glue that
    // statement onto the selector that follows it, and the merged text starts with `@`, so a hiding rule after an
    // `@import` would be skipped as though it were an at-rule. A browser discards the statement and applies the rule.
    const statementEnd = endOfStatement(css, index);
    if (statementEnd !== null) {
      // An `@import` pulls in a stylesheet this never fetches, and that stylesheet may hold the rule that hides
      // the injected text. Counted, for the same reason a selector we cannot read is counted: the reader is told
      // the sanitiser did not see everything. It is caught here rather than in the at-rule branch below, because
      // an `@import` ends in a semicolon and never reaches one.
      if (/^\s*@import\b/i.test(css.slice(index, statementEnd))) unreadable.count += 1;
      index = statementEnd;
      continue;
    }
    const open = css.indexOf('{', index);
    if (open < 0) return;
    const prelude = css.slice(index, open).trim();

    // Braces inside a string are text, not structure: `.a::after{content:"}"}` would otherwise end the rule early
    // and leave the rest of the stylesheet — including whatever hides the injected text — parsed as garbage.
    let depth = 1;
    let cursor = open + 1;
    let quote: string | null = null;
    while (cursor < css.length && depth > 0) {
      const character = css[cursor];
      if (quote) {
        if (character === '\\') cursor++;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === '{') {
        depth++;
      } else if (character === '}') {
        depth--;
      }
      cursor++;
    }
    const body = css.slice(open + 1, Math.max(open + 1, cursor - 1));

    if (prelude.startsWith('@')) {
      const printOnly = isPrintOnly(prelude);
      if (NESTING_AT_RULES.test(prelude) && !printOnly) eachStyleRule(body, visit, unreadable);
      // @font-face, @keyframes, @import and the rest hide nothing.
    } else if (prelude) {
      visit(prelude, body);
    }
    index = cursor;
  }
}

function hiddenSelectorsFromStylesheets(root: AnyNode): StylesheetRules {
  const rules: StylesheetRules = { rules: [], unreadable: 0 };
  const visit = (node: AnyNode): void => {
    if (isTag(node) && node.name === 'style') {
      const css = node.children
        .filter(isText)
        .map((t) => t.data)
        .join('')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      const counter = { count: 0 };
      eachStyleRule(
        css,
        (selectors, declarations) => {
          const parsed = parseStyle(declarations);
          if (!hidesContent(parsed)) {
            if (usesUnresolvedVariable(parsed)) rules.unreadable += 1;
            return;
          }
          for (const raw of selectors.split(',')) {
            if (!raw.trim()) continue;
            const rule = parseHidingSelector(raw);
            if (rule) rules.rules.push(rule);
            // A hiding rule we could not apply means text a client would hide is still in the output. Counted,
            // not guessed at: `unreadableHidingRules` is how the reader learns that.
            else if (!INTERACTION_PSEUDO.test(raw.toLowerCase())) rules.unreadable += 1;
          }
        },
        counter,
      );
      rules.unreadable += counter.count;
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

/** CSS attribute comparison, so `div[data-x]` hides the divs carrying it rather than every div. */
function attributeMatches(actual: string | undefined, attribute: { operator: string; value: string }): boolean {
  if (actual === undefined) return false;
  const value = attribute.value.toLowerCase();
  const found = actual.toLowerCase();
  switch (attribute.operator) {
    case '':
      return true;
    case '=':
      return found === value;
    case '~=':
      return found.split(/\s+/).includes(value);
    case '|=':
      return found === value || found.startsWith(`${value}-`);
    case '^=':
      return found.startsWith(value);
    case '$=':
      return found.endsWith(value);
    case '*=':
      return found.includes(value);
    default:
      return false;
  }
}

function isHiddenElement(element: Element, rules: StylesheetRules): boolean {
  const attribs = element.attribs;
  if ('hidden' in attribs) return true;
  if ((attribs['aria-hidden'] ?? '').toLowerCase() === 'true') return true;
  const id = (attribs.id ?? '').toLowerCase();
  const classes = new Set((attribs.class ?? '').toLowerCase().split(/\s+/).filter(Boolean));
  for (const rule of rules.rules) {
    if (rule.tag && rule.tag !== element.name) continue;
    if (rule.id && rule.id !== id) continue;
    if (rule.classes.some((name) => !classes.has(name))) continue;
    if (rule.attributes.some((attribute) => !attributeMatches(attribs[attribute.name], attribute))) continue;
    return true;
  }
  const style = parseStyle(attribs.style);
  if (hidesContent(style)) return true;
  // A custom property in a hiding-relevant place cannot be read without the cascade. The element is kept — removing
  // it on a guess would eat text a reader can see — and counted, so the reader is told the sanitiser was unsure.
  if (usesUnresolvedVariable(style)) rules.unreadable += 1;
  // <font size="1"> and smaller is still readable; only an explicit zero is hidden.
  if (element.name === 'font' && attribs.size !== undefined && Number(attribs.size) <= 0) return true;
  return false;
}

/** Removes hidden nodes in place and counts them. */
function prune(nodes: ChildNode[], rules: StylesheetRules, report: SanitizeReport): ChildNode[] {
  const kept: ChildNode[] = [];
  for (const node of nodes) {
    if (isComment(node)) {
      // A comment is content a reader never sees, and an injection hidden in one used to leave no trace at all:
      // removed before the counting branch, so `hiddenElements` stayed at zero and the reader was told nothing.
      if (node.data.trim()) {
        report.hiddenElements += 1;
        report.hiddenChars += node.data.trim().length;
      }
      continue;
    }
    if (isText(node)) {
      // Strip before conversion: the converter treats a zero-width space as a word break.
      const stripped = stripInvisible(node.data);
      report.invisibleCharsRemoved += stripped.removed;
      node.data = stripped.text;
    }
    if (isTag(node)) {
      // `<template>`, `<noscript>`, `<title>` and the rest are never shown, and counted for the same reason a
      // comment is. A `<style>` block is the exception: its text is a stylesheet, not something anybody was meant
      // to read, and counting every message's CSS as "hidden content" would make the number meaningless.
      if (DROP_TAGS.has(node.name)) {
        const length = node.name === 'style' ? 0 : textLength(node);
        if (length > 0) {
          report.hiddenElements += 1;
          report.hiddenChars += length;
        }
        continue;
      }
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
  // Counted after pruning, because the element walk adds to it too: anything hidden through a custom property this
  // cannot resolve is kept in the output and reported here rather than passed off as visible.
  report.unreadableHidingRules = rules.unreadable;
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
  /** `<form>` elements. Mail clients do not submit them, but their presence says the message is trying. */
  forms: number;
  /** Interactive fields — input, button, select, textarea — whether or not they sit inside a form. */
  formFields: number;
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
const FORM_FIELD_TAGS = new Set(['input', 'button', 'select', 'textarea']);
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
    formFields: 0,
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
      if (tag === 'form') report.forms += 1;
      else if (FORM_FIELD_TAGS.has(tag)) report.formFields += 1;
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
