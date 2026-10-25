/**
 * The activity log's two settings (design 2026-10-25-activity §4.1): `activity.record`, `on` or `off`, and
 * `activity.retentionDays`, a whole number of days from 1 to 365. Absent, they read as on and 30.
 *
 * `config.json` keeps them as `activity: { record, retentionDays }`, a key the schemas do not name, so every release
 * sharing the file keeps it through its writes, as it keeps `agentLabel` and `behaviour`. It is read only through
 * `readActivitySettings`, which reads a value it does not understand as recording nothing — never as the default.
 * `off` and fewer days are the tightenings, which apply at once, and `on` and more days the loosenings, which a person
 * approves (`classifyChange`). So a hand edit or a later release's word can only make this release record less.
 *
 * A retention it cannot read is read as the longest, 365 days, with recording off: what it cannot read must never
 * delete what is held. Read as one day, a typo — or a later release's word — once deleted all but a day of the log.
 *
 * `config.ts` imports this module to judge a change, so it imports nothing at all.
 */

export const ACTIVITY_RECORD_SETTINGS: readonly ['on', 'off'] = Object.freeze(['on', 'off'] as const);
export type ActivityRecordSetting = (typeof ACTIVITY_RECORD_SETTINGS)[number];

export const MIN_ACTIVITY_RETENTION_DAYS = 1;
export const MAX_ACTIVITY_RETENTION_DAYS = 365;
export const DEFAULT_ACTIVITY_RETENTION_DAYS = 30;

/** The settings as they apply, and what in the file could not be read as written (empty when all of it could). */
export interface ActivitySettings {
  readonly record: ActivityRecordSetting;
  readonly retentionDays: number;
  /** One sentence for each value read as something stricter than the file says — for `doctor` to show. */
  readonly problems: readonly string[];
}

/** Whether `value` is a retention a person can set: a whole number of days from 1 to 365. */
export function isActivityRetention(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_ACTIVITY_RETENTION_DAYS &&
    value <= MAX_ACTIVITY_RETENTION_DAYS
  );
}

export function isActivityRecordSetting(value: unknown): value is ActivityRecordSetting {
  return value === 'on' || value === 'off';
}

/** The `activity` block as the file holds it, raw: an object, or nothing. */
export function storedActivity(config: { readonly activity?: unknown }): Readonly<Record<string, unknown>> | null {
  const stored = config.activity;
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored)
    ? (stored as Record<string, unknown>)
    : null;
}

/**
 * The settings in force for `config`. A missing block, or a missing key, is the default. Anything else this release
 * cannot read is named in `problems`, and read so that nothing is recorded and nothing is deleted: a word other than
 * `on` or `off` as `off`; a retention that is not a whole number from 1 to 365 — out of range, a fraction, not a
 * number — as 365 days with recording `off`; a block that is not an object as both.
 */
export function readActivitySettings(config: { readonly activity?: unknown }): ActivitySettings {
  const problems: string[] = [];
  const raw = config.activity;
  if (raw === undefined) return { record: 'on', retentionDays: DEFAULT_ACTIVITY_RETENTION_DAYS, problems };
  const stored = storedActivity(config);
  if (stored === null) {
    problems.push(
      `activity in config.json is not an object, so recording is off and ${MAX_ACTIVITY_RETENTION_DAYS} days are kept`,
    );
    return { record: 'off', retentionDays: MAX_ACTIVITY_RETENTION_DAYS, problems };
  }
  let record: ActivityRecordSetting = 'on';
  if (stored.record !== undefined) {
    if (isActivityRecordSetting(stored.record)) record = stored.record;
    else {
      record = 'off';
      problems.push(`activity.record is ${describe(stored.record)}, not on or off, so recording is off`);
    }
  }
  let retentionDays = DEFAULT_ACTIVITY_RETENTION_DAYS;
  const days = stored.retentionDays;
  if (days !== undefined) {
    if (isActivityRetention(days)) retentionDays = days;
    else {
      retentionDays = MAX_ACTIVITY_RETENTION_DAYS;
      record = 'off';
      problems.push(
        `activity.retentionDays is ${describe(days)}, not a whole number from ${MIN_ACTIVITY_RETENTION_DAYS} to ${MAX_ACTIVITY_RETENTION_DAYS}, so recording is off and ${MAX_ACTIVITY_RETENTION_DAYS} days are kept`,
      );
    }
  }
  return { record, retentionDays, problems };
}

/** A stored value in a sentence: short, and never more than a few dozen characters of whatever the file held. */
function describe(value: unknown): string {
  const text = typeof value === 'string' ? JSON.stringify(value) : String(JSON.stringify(value) ?? value);
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}
