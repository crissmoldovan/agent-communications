/**
 * The emoji a standing approval may react with (design 2026-10-19-standing-approvals, S3 and §8.4): a curated list of
 * standard Unicode names, each with its code point, shipped in the code.
 *
 * Only standard names, because a custom workspace emoji's image can be replaced under the same name: the person would
 * have approved a picture that is no longer the one sent. And a short list rather than every Unicode name, because each
 * one here is a word the agent may say on the person's behalf without asking.
 */
export const STANDARD_EMOJI: Readonly<Record<string, string>> = Object.freeze({
  eyes: 'U+1F440',
  white_check_mark: 'U+2705',
  heavy_check_mark: 'U+2714',
  ballot_box_with_check: 'U+2611',
  '+1': 'U+1F44D',
  thumbsup: 'U+1F44D',
  ok: 'U+1F197',
  ok_hand: 'U+1F44C',
  '100': 'U+1F4AF',
  heavy_plus_sign: 'U+2795',
  handshake: 'U+1F91D',
  raised_hands: 'U+1F64C',
  pray: 'U+1F64F',
  clap: 'U+1F44F',
  wave: 'U+1F44B',
  memo: 'U+1F4DD',
  pencil2: 'U+270F',
  hourglass_flowing_sand: 'U+23F3',
  stopwatch: 'U+23F1',
  inbox_tray: 'U+1F4E5',
  pushpin: 'U+1F4CC',
  mag: 'U+1F50D',
  bulb: 'U+1F4A1',
  speech_balloon: 'U+1F4AC',
  thinking_face: 'U+1F914',
  slightly_smiling_face: 'U+1F642',
  heart: 'U+2764',
  tada: 'U+1F389',
  rocket: 'U+1F680',
  sparkles: 'U+2728',
});

/**
 * The emoji among them that people read as a yes: ✅ on "can I deploy?" is taken for approval, and a Slack workflow
 * can start on a reaction (S3). Allowed, with a warning in the preview.
 */
export const READS_AS_APPROVAL: readonly string[] = Object.freeze([
  'white_check_mark',
  'heavy_check_mark',
  'ballot_box_with_check',
  '+1',
  'thumbsup',
  'ok',
  'ok_hand',
  '100',
  'heavy_plus_sign',
  'handshake',
]);

/** Whether `name` is one of the standard emoji a standing approval may hold, exactly as listed. */
export function isStandardEmoji(name: string): boolean {
  return Object.hasOwn(STANDARD_EMOJI, name);
}
