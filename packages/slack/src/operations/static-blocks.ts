/**
 * Which Block Kit a message may carry and still be acknowledged by a standing approval (design
 * 2026-10-19-standing-approvals, S4, the lead's call after review): an allow-list of blocks that show something and
 * offer nothing to press, fill in or choose. Anything else — a button, a select, an input, `context_actions`,
 * `feedback_buttons`, `icon_button`, a block type Slack adds tomorrow — reads as something a person may answer, and a
 * reaction on it can read as that answer. Unclear is interactive.
 *
 * - `section`: text and fields of plain text or mrkdwn, and no accessory but an image;
 * - `context`: elements of plain text, mrkdwn or images only;
 * - `divider`, `header` (plain text), `image`;
 * - `rich_text`: sections, lists, quotes and preformatted runs of text, links, emoji, mentions, dates and colours.
 */

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A text object: plain text or mrkdwn, and nothing else. */
function textObject(value: unknown): boolean {
  return isRecord(value) && (value.type === 'plain_text' || value.type === 'mrkdwn');
}

/** An image element, which shows a picture and does nothing when pressed. */
function imageElement(value: unknown): boolean {
  return isRecord(value) && value.type === 'image';
}

/** What a rich text run may hold: words, links, emoji, mentions, dates and colours — never anything to press. */
const RICH_INLINE = new Set(['text', 'link', 'emoji', 'user', 'usergroup', 'channel', 'broadcast', 'date', 'color']);
/** The containers a rich text block is made of. */
const RICH_CONTAINERS = new Set(['rich_text_section', 'rich_text_preformatted', 'rich_text_quote']);

function richElement(value: unknown, depth: number): boolean {
  if (depth > 8 || !isRecord(value) || typeof value.type !== 'string') return false;
  if (RICH_INLINE.has(value.type)) return true;
  const children = value.elements;
  if (!Array.isArray(children)) return false;
  if (RICH_CONTAINERS.has(value.type)) return children.every((child) => richElement(child, depth + 1));
  // A list holds sections, each of words.
  if (value.type === 'rich_text_list') {
    return children.every(
      (child) => isRecord(child) && child.type === 'rich_text_section' && richElement(child, depth + 1),
    );
  }
  return false;
}

/** Whether one block is on the allow-list, by its type and what it holds. */
function staticBlock(block: unknown): boolean {
  if (!isRecord(block)) return false;
  switch (block.type) {
    case 'divider':
      return true;
    case 'image':
      return true;
    case 'header':
      return isRecord(block.text) && block.text.type === 'plain_text';
    case 'section': {
      if (block.text !== undefined && !textObject(block.text)) return false;
      if (block.fields !== undefined && !(Array.isArray(block.fields) && block.fields.every(textObject))) return false;
      return block.accessory === undefined || imageElement(block.accessory);
    }
    case 'context':
      return (
        Array.isArray(block.elements) && block.elements.every((element) => textObject(element) || imageElement(element))
      );
    case 'rich_text':
      return Array.isArray(block.elements) && block.elements.every((element) => richElement(element, 0));
    default:
      return false;
  }
}

/**
 * Whether `blocks` holds only what the allow-list allows: none at all, or an array of static blocks. A `blocks` that is
 * not an array cannot be read, and is not static.
 */
export function onlyStaticBlocks(blocks: unknown): boolean {
  if (blocks === undefined || blocks === null) return true;
  return Array.isArray(blocks) && blocks.every(staticBlock);
}
