import { type SanitizeReport, sanitizeHtmlToText, sanitizePlainText } from '@cloudpixel/comms-core';
import type { MessageParts } from './mime.ts';

/**
 * Turning a message into the text an agent may read.
 *
 * **The HTML part is authoritative**, because it is what Gmail shows the person. The plain-text part is read too,
 * but only to compare: a Gmail reader never sees it, which makes it the natural place to hide an instruction aimed
 * at a model. Text that appears only there is reported as a mismatch and counted as hidden, never silently merged.
 */

export interface QuoteCollapse {
  /** Lines of quoted history and signature removed from the body. */
  linesOmitted: number;
  /** Where the collapse happened, for a caller that wants the whole thing back. */
  collapsed: boolean;
}

export interface BodyMismatch {
  /** Characters of meaningful text present in the plain part and absent from the visible HTML. */
  extraChars: number;
  /** A short, already-sanitised sample, so a reviewer can see what it was without reading the whole part. */
  sample: string;
}

export interface MessageBody {
  text: string;
  /** Which part the text came from. */
  source: 'html' | 'plain' | 'none';
  report: SanitizeReport;
  quoted: QuoteCollapse;
  mismatch: BodyMismatch | undefined;
  truncated: boolean;
  /** Where a continuation should start; absent when the body is complete. */
  nextOffset: number | undefined;
  /** Total characters available before truncation. */
  totalChars: number;
}

export interface BodyOptions {
  /** Keep quoted history and signatures instead of collapsing them. */
  includeQuoted?: boolean | undefined;
  maxChars?: number | undefined;
  offset?: number | undefined;
}

export const DEFAULT_MAX_CHARS = 8000;
/**
 * How much text has to appear only in the plain part before it is reported. Low enough to catch a short instruction
 * (about ten words), high enough to ignore what differs between the parts in ordinary mail: a signature line, an
 * unsubscribe footer, "Sent from my phone".
 */
const MISMATCH_THRESHOLD_CHARS = 60;

/** Markers Gmail and other clients leave where quoted history starts. */
const QUOTE_MARKERS = [
  /^On .{10,120}\bwrote:\s*$/,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{5,}$/,
  /^From:\s.+$/,
  /^Sent from my \w+/i,
];

/** A signature block: the standard `-- ` separator, and nothing after it. */
const SIGNATURE_MARKER = /^--\s?$/;

/**
 * Collapses quoted history and signatures. Conservative: it cuts at the first marker that has real text before it,
 * so a reply whose new content sits under the quote is not emptied out.
 */
export function collapseQuoted(text: string): { text: string; quoted: QuoteCollapse } {
  const lines = text.split('\n');
  let cut = -1;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    const isMarker = SIGNATURE_MARKER.test(trimmed) || QUOTE_MARKERS.some((marker) => marker.test(trimmed));
    if (!isMarker) continue;
    const before = lines.slice(0, index).join('\n').trim();
    if (before.length === 0) continue;
    cut = index;
    break;
  }
  // A run of `>` quoting counts too, when it is the tail of the message.
  if (cut === -1) {
    for (let index = lines.length - 1; index >= 0; index--) {
      if (lines[index]?.trim() === '') continue;
      if (!/^\s*>/.test(lines[index] ?? '')) break;
      cut = index;
    }
    if (cut !== -1 && lines.slice(0, cut).join('\n').trim().length === 0) cut = -1;
  }
  if (cut === -1) return { text, quoted: { linesOmitted: 0, collapsed: false } };

  const kept = lines.slice(0, cut).join('\n').replace(/\s+$/, '');
  const omitted = lines.length - cut;
  return {
    text: `${kept}\n\n[quoted: ${omitted} lines omitted — pass includeQuoted to see them]`,
    quoted: { linesOmitted: omitted, collapsed: true },
  };
}

/** Words of four characters or more, lower-cased: enough to tell "this text is elsewhere too" from "this is new". */
function meaningfulTokens(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of text.toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}'-]{3,}/gu)) {
    const word = match[0];
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/** What the plain part says that the visible HTML does not. */
export function compareParts(htmlText: string, plainText: string): BodyMismatch | undefined {
  const visible = meaningfulTokens(htmlText);
  const extra: string[] = [];
  let extraChars = 0;
  for (const [word, count] of meaningfulTokens(plainText)) {
    const seen = visible.get(word) ?? 0;
    if (seen >= count) continue;
    const missing = count - seen;
    extraChars += word.length * missing;
    if (extra.length < 40) extra.push(word);
  }
  if (extraChars < MISMATCH_THRESHOLD_CHARS) return undefined;
  return { extraChars, sample: extra.join(' ').slice(0, 300) };
}

function mergeReports(primary: SanitizeReport, secondary: SanitizeReport): SanitizeReport {
  return {
    hiddenElements: primary.hiddenElements + secondary.hiddenElements,
    hiddenChars: primary.hiddenChars + secondary.hiddenChars,
    sameColorElements: primary.sameColorElements + secondary.sameColorElements,
    invisibleCharsRemoved: primary.invisibleCharsRemoved + secondary.invisibleCharsRemoved,
    unreadableHidingRules: primary.unreadableHidingRules + secondary.unreadableHidingRules,
    links: [...primary.links, ...secondary.links],
    imagesNotLoaded: primary.imagesNotLoaded + secondary.imagesNotLoaded,
  };
}

/**
 * The body a caller sees: sanitised, quote-collapsed, truncated with a continuation offset, and carrying everything
 * that was removed or that disagreed — so nothing is dropped without being counted.
 */
export function buildBody(parts: MessageParts, options: BodyOptions = {}): MessageBody {
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const offset = Math.max(0, options.offset ?? 0);

  const htmlSource = parts.html.map((part) => part.text ?? '').join('\n');
  const plainSource = parts.plain.map((part) => part.text ?? '').join('\n');
  const html = htmlSource ? sanitizeHtmlToText(htmlSource) : undefined;
  const plain = plainSource ? sanitizePlainText(plainSource) : undefined;

  const htmlHasText = Boolean(html && html.text.trim().length > 0);
  const source: MessageBody['source'] = htmlHasText ? 'html' : plain?.text.trim() ? 'plain' : 'none';

  let report = (htmlHasText ? html?.report : plain?.report) ?? sanitizePlainText('').report;
  let mismatch: BodyMismatch | undefined;
  if (htmlHasText && plain && plain.text.trim()) {
    mismatch = compareParts(html?.text ?? '', plain.text);
    if (mismatch) {
      // Text only a model would ever read is hidden text, and is counted as such.
      report = { ...report, hiddenChars: report.hiddenChars + mismatch.extraChars };
    }
  }
  if (!htmlHasText && html && plain) report = mergeReports(report, html.report);

  const full = (htmlHasText ? html?.text : plain?.text) ?? '';
  const collapsed = options.includeQuoted
    ? { text: full, quoted: { linesOmitted: 0, collapsed: false } }
    : collapseQuoted(full);
  const totalChars = collapsed.text.length;
  const window = collapsed.text.slice(offset, offset + maxChars);
  const truncated = offset + window.length < totalChars;

  return {
    text: window,
    source,
    report,
    quoted: collapsed.quoted,
    mismatch,
    truncated,
    nextOffset: truncated ? offset + window.length : undefined,
    totalChars,
  };
}
