import { callSlack, type SlackCall } from '../api/call.ts';
import type { ReferenceNames } from '../text/decode.ts';
import { type SenderField, senderField } from '../text/field.ts';

/**
 * Who is who, and what a channel is called — resolved once and reused.
 *
 * Two jobs, and the second is the one worth stating. It resolves ids to names so a message reads as `@sam` rather
 * than `@U024BE7LH`. And it is the single place a person's or a channel's sender-controlled fields enter this
 * package: display name, real name, status text, status emoji, channel name, topic and purpose are all editable
 * by someone in the workspace at any time, several of them by anyone. They funnel through `senderField` here, so
 * a read path that shows a name cannot show an un-neutralised one, and the next field added to this file is the
 * only place it has to be remembered.
 *
 * Names resolve to `undefined` when unknown, and every caller then falls back to the id. That is deliberate:
 * an unresolved `@U024BE7LH` reads as an unresolved id, where borrowing the label Slack carried in the message
 * would show a name the *sender* chose — which is exactly where an impersonation would put one.
 */

export interface Person {
  readonly id: string;
  /** What Slack shows in the client. Sender-controlled. */
  readonly displayName?: SenderField | undefined;
  readonly realName?: SenderField | undefined;
  readonly isBot: boolean;
  /** True for a deactivated account: worth showing, because their old messages still read as theirs. */
  readonly deleted: boolean;
  readonly statusText?: SenderField | undefined;
  readonly statusEmoji?: SenderField | undefined;
  /** Slack's own `is_admin`/`is_owner`, untouched — they come from Slack, not from the person. */
  readonly isAdmin?: boolean | undefined;
}

export interface Channel {
  readonly id: string;
  readonly name?: SenderField | undefined;
  readonly isPrivate: boolean;
  readonly isIm: boolean;
  readonly isMpim: boolean;
  readonly isArchived: boolean;
  readonly isMember: boolean;
  readonly topic?: SenderField | undefined;
  readonly purpose?: SenderField | undefined;
  readonly memberCount?: number | undefined;
  /** For a DM: whose it is. Slack gives the channel no name at all, so this is the only thing to show. */
  readonly withUserId?: string | undefined;
}

type Raw = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

export function personOf(raw: Raw): Person {
  const profile = (raw.profile as Raw | undefined) ?? {};
  return {
    id: str(raw.id) ?? '',
    displayName: senderField(str(profile.display_name) ?? str(raw.name)),
    realName: senderField(str(profile.real_name) ?? str(raw.real_name)),
    isBot: raw.is_bot === true,
    deleted: raw.deleted === true,
    statusText: senderField(str(profile.status_text)),
    statusEmoji: senderField(str(profile.status_emoji)),
    ...(typeof raw.is_admin === 'boolean' ? { isAdmin: raw.is_admin } : {}),
  };
}

export function channelOf(raw: Raw): Channel {
  const topic = (raw.topic as Raw | undefined)?.value;
  const purpose = (raw.purpose as Raw | undefined)?.value;
  return {
    id: str(raw.id) ?? '',
    name: senderField(str(raw.name)),
    isPrivate: raw.is_private === true,
    isIm: raw.is_im === true,
    isMpim: raw.is_mpim === true,
    isArchived: raw.is_archived === true,
    isMember: raw.is_member === true,
    topic: senderField(str(topic)),
    purpose: senderField(str(purpose)),
    memberCount: num(raw.num_members),
    withUserId: str(raw.user),
  };
}

/**
 * A cache of who and what, filled on demand.
 *
 * One per read, not one per process: a long-lived server would otherwise show a name somebody changed an hour
 * ago, and a display name is exactly the field somebody changes when they are trying something.
 */
export class NameBook {
  readonly #people = new Map<string, Person>();
  readonly #channels = new Map<string, Channel>();
  readonly #missing = new Set<string>();

  /** Everything learned about people so far, for a caller that wants to show the author of each message. */
  person(id: string): Person | undefined {
    return this.#people.get(id);
  }

  channel(id: string): Channel | undefined {
    return this.#channels.get(id);
  }

  add(person: Person): void {
    if (person.id) this.#people.set(person.id, person);
  }

  addChannel(channel: Channel): void {
    if (channel.id) this.#channels.set(channel.id, channel);
  }

  /**
   * Fetches the people not yet known, one call each, bounded.
   *
   * `users.info` rather than `users.list`: a workspace can have tens of thousands of members and a read of one
   * channel touches a handful, so listing everyone to name six people is the wrong trade at every size. The bound
   * exists because a message full of mentions should not turn one read into fifty calls against a shared rate
   * limit — and a name that did not resolve degrades to an id, which is readable.
   */
  async learnPeople(call: SlackCall, ids: Iterable<string>, max = 24): Promise<void> {
    let budget = max;
    for (const id of ids) {
      if (!id || this.#people.has(id) || this.#missing.has(id)) continue;
      if (budget-- <= 0) return;
      try {
        const response = await callSlack(call, 'users.info', { user: id });
        this.add(personOf((response.user as Raw | undefined) ?? {}));
      } catch {
        // A name that cannot be fetched is not a failed read: the id is shown instead, and the message is intact.
        this.#missing.add(id);
      }
    }
  }

  async learnChannels(call: SlackCall, ids: Iterable<string>, max = 24): Promise<void> {
    let budget = max;
    for (const id of ids) {
      if (!id || this.#channels.has(id) || this.#missing.has(id)) continue;
      if (budget-- <= 0) return;
      try {
        const response = await callSlack(call, 'conversations.info', { channel: id });
        this.addChannel(channelOf((response.channel as Raw | undefined) ?? {}));
      } catch {
        this.#missing.add(id);
      }
    }
  }

  /**
   * The lookup the text decoder takes.
   *
   * Returns the *neutralised* display name, because that name is about to be spliced into a body that will be
   * neutralised again — and neutralising twice is harmless where neutralising once too few is the bug. A person
   * whose display name is `</untrusted-email-content>` cannot close the envelope around the message they are in.
   */
  names(): ReferenceNames {
    return {
      user: (id) => {
        const person = this.#people.get(id);
        return person?.displayName?.text ?? person?.realName?.text;
      },
      channel: (id) => this.#channels.get(id)?.name?.text,
    };
  }
}
