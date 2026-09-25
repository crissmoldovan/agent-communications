import { randomInt } from 'node:crypto';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError, writeFileAtomic } from '@agentcomms/core';
import type { ComposedPayload } from './blocks.ts';

/**
 * A Slack draft, which lives here rather than in Slack.
 *
 * Slack has no server-side draft: the client's `drafts.*` endpoints are undocumented, need browser-session
 * credentials, and are not supported. So a draft is a local file holding the payload exactly as it would be
 * posted — which is better than Gmail in one way and worse in another, and the skill has to say both.
 *
 * **Better:** nothing exists in Slack until the person says yes. A Gmail draft is already in the mailbox, visible
 * to anything else with access to that account.
 *
 * **Worse:** the person cannot open it in Slack and finish it themselves. Gmail's "send it from the app instead"
 * escape hatch, which `never` policy relies on, does not exist here — so the equivalent is "here is the text,
 * paste it yourself", and the preview is written to be pasteable.
 *
 * The approval digest covers the stored payload, so "approve this" and "post this" are the same bytes. That is
 * the whole reason the payload is stored composed rather than as the input that produced it.
 */

export interface SlackDraft {
  readonly draftId: string;
  /** The account this belongs to, by immutable id — a rename must not orphan a draft. */
  readonly accountId: string;
  /**
   * Changes on every save.
   *
   * An approval binds to this, so any edit invalidates it — including one that restores identical content. The
   * Gmail package learned this the hard way: binding to the content alone let a draft be edited and restored
   * between approval and send, which is indistinguishable from never having been touched.
   */
  readonly revision: string;
  readonly payload: ComposedPayload;
  /** What the author typed, kept so an edit starts from their words rather than from the escaped form. */
  readonly source: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * `randomInt`, not `byte % 62` — the same reasoning as `newFlowId`.
 *
 * 256 is not a multiple of 62, so folding a random byte into the alphabet makes its first eight characters a
 * quarter likelier than the rest. A draft id secures nothing, but it names a file, and the fix costs nothing.
 */
function newDraftId(): string {
  let out = '';
  for (let i = 0; i < 22; i += 1) out += BASE62[randomInt(BASE62.length)];
  return `dft_${out}`;
}

/** A fresh revision marker, for the same reason and by the same means. */
function newRevision(): string {
  let out = '';
  for (let i = 0; i < 12; i += 1) out += BASE62[randomInt(BASE62.length)];
  return out;
}

function draftsDir(stateDir: string): string {
  return join(stateDir, 'slack', 'drafts');
}

function pathFor(stateDir: string, draftId: string): string {
  /*
   * The id is generated here and never taken from a caller, so it cannot contain a separator — but this is the
   * one place a draft id becomes a filesystem path, and a check that costs nothing is cheaper than the argument
   * about whether every caller is trustworthy.
   */
  if (!/^dft_[A-Za-z0-9]{22}$/.test(draftId)) {
    throw new CommsError('BAD_DATA', `"${draftId}" is not a draft id`);
  }
  return join(draftsDir(stateDir), `${draftId}.json`);
}

export interface DraftStore {
  create(accountId: string, payload: ComposedPayload, source: string): Promise<SlackDraft>;
  get(draftId: string): Promise<SlackDraft>;
  list(accountId?: string): Promise<SlackDraft[]>;
  update(draftId: string, payload: ComposedPayload, source: string): Promise<SlackDraft>;
  remove(draftId: string): Promise<void>;
  /**
   * The account a draft `get` cannot read still names, or `undefined` when it names none.
   *
   * For deleting one, and nothing else. A draft that would not parse was refused by the delete as well, because the
   * delete read it first to check whose it was — so the refusal's own advice, "delete it", could not be followed.
   */
  ownerOf(draftId: string): Promise<string | undefined>;
}

/** Whether what a draft file parsed to has every field something reading a draft goes on to use. */
function isDraftShaped(parsed: unknown): parsed is SlackDraft {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const draft = parsed as Record<string, unknown>;
  const text = ['draftId', 'accountId', 'revision', 'source', 'createdAt', 'updatedAt'];
  if (!text.every((field) => typeof draft[field] === 'string')) return false;
  const payload = draft.payload as Record<string, unknown> | null | undefined;
  return (
    typeof payload === 'object' &&
    payload !== null &&
    typeof payload.channel === 'string' &&
    typeof payload.text === 'string'
  );
}

/** Whether an error is `get` saying a draft file exists but is not a draft. */
export function isUnreadableDraft(error: unknown): boolean {
  return error instanceof CommsError && error.code === 'BAD_DATA' && error.details?.reason === 'unreadable';
}

export function openDraftStore(stateDir: string, now: () => Date): DraftStore {
  const read = async (draftId: string): Promise<SlackDraft> => {
    /*
     * Outside the try, deliberately.
     *
     * Inside it, a draft id that was *refused* — `../../etc/passwd` — came back as "no draft", which reports a
     * rejected input as an absent one. The traversal was blocked either way, but the message sent whoever wrote
     * it looking for a draft that had never existed instead of telling them what was wrong with what they typed.
     */
    const path = pathFor(stateDir, draftId);
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      throw new CommsError('NOT_FOUND', `no draft "${draftId}"`, {
        hint: 'List them with `agent-slack draft list --workspace <name>`.',
      });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    /*
     * Parsed is not the same as readable. `null` and `[]` parse, and a caller reading `accountId` off either threw a
     * TypeError instead of saying which draft was damaged — so a draft with no owner is as unreadable as one that
     * would not parse at all.
     *
     * Nor is having an owner. `{"accountId": …}` alone was accepted, and then `draft list` failed for the whole
     * workspace sorting on the `updatedAt` it lacked, and preparing it failed on its missing channel — one damaged
     * file hid every draft beside it. So every field a reader relies on is checked here, once, where the refusal can
     * still name the draft.
     */
    if (!isDraftShaped(parsed)) {
      throw new CommsError('BAD_DATA', `draft "${draftId}" could not be read`, {
        hint: `Delete it with \`agent-slack draft delete ${draftId} --workspace <name>\` and compose it again.`,
        details: { reason: 'unreadable' },
      });
    }
    return parsed;
  };

  const write = async (draft: SlackDraft): Promise<SlackDraft> => {
    await writeFileAtomic(pathFor(stateDir, draft.draftId), `${JSON.stringify(draft, null, 2)}\n`);
    return draft;
  };

  return {
    async create(accountId, payload, source) {
      const at = now().toISOString();
      return write({
        draftId: newDraftId(),
        accountId,
        revision: newRevision(),
        payload,
        source,
        createdAt: at,
        updatedAt: at,
      });
    },
    get: read,
    async list(accountId) {
      let names: string[];
      try {
        names = await readdir(draftsDir(stateDir));
      } catch {
        return [];
      }
      const drafts: SlackDraft[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const draft = await read(name.slice(0, -'.json'.length));
          if (accountId === undefined || draft.accountId === accountId) drafts.push(draft);
        } catch {
          // One unreadable draft is not a failed list: the others are still there and still sendable.
        }
      }
      return drafts.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async update(draftId, payload, source) {
      const existing = await read(draftId);
      return write({
        ...existing,
        payload,
        source,
        // A new revision on every save, even when the content is identical — see the field's own note.
        revision: newRevision(),
        updatedAt: now().toISOString(),
      });
    },
    async remove(draftId) {
      await rm(pathFor(stateDir, draftId), { force: true });
    },
    async ownerOf(draftId) {
      const path = pathFor(stateDir, draftId);
      let raw: string;
      try {
        raw = await readFile(path, 'utf8');
      } catch {
        throw new CommsError('NOT_FOUND', `no draft "${draftId}"`, {
          hint: 'List them with `agent-slack draft list --workspace <name>`.',
        });
      }
      /*
       * Read off the raw text, because a draft that got here would not parse. Drafts are written with `accountId` on
       * their second line, so a file cut off part-way — the usual way one breaks — still says whose it was.
       */
      const named = /"accountId"\s*:\s*"([^"\\]+)"/.exec(raw);
      return named?.[1];
    },
  };
}
