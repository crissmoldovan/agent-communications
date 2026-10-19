import { type CliHandoffs, CommsError, handoffSentence, truncateDisplay } from '@agentcomms/core';
import { USER_ID } from '../compose/blocks.ts';

/*
 * A conversation id: a channel's C…, a private channel's or a group DM's G…, a DM's D… — in capitals and digits, as Slack
 * writes them. Never a name: Slack takes `general` and `#general` where a channel goes, and a name matches no rule.
 */
const CONVERSATION_ID = /^[CGD][A-Z0-9]{1,39}$/;

/**
 * Refuses anything but a conversation id as the place an act lands, before anything is written, read or asked of Slack.
 *
 * A user id first, in its own words — issue #43. Only the destination: a mention takes a user id, as ever. A post goes to
 * a conversation. A person is not one: a direct message with them has an id of its own, `D…`, and it is that
 * conversation the gate reads, counts and shows in the preview. Whatever Slack would do with a user id there, it is not
 * a room the preview could have described.
 *
 * Then anything else that is not a conversation id: a channel's name, `#name`, an id in lower case (review of spec 2,
 * finding 8). `chat.postMessage` takes a name and posts into the room it names, but the behaviour rules name rooms by
 * their ids, so a name would be held to no rule — `eng` went into #eng past a rule for `C0ENG` — and the preview would
 * describe a room the gate never read. (Beneath this, core holds a place that is no id to every rule of the account.)
 *
 * Asked by every operation that takes a destination — `createDraft`, `updateDraft`, `prepareDraftPost` given a new
 * message, a reaction's prepare and claim, and an edit's or a deletion's (`requireMessageAt`) — and again by `viewPost`,
 * so a draft stored before, or written by hand, is refused at prepare and at send.
 */
export function requireConversation(channel: string, alias: string, handoffs: CliHandoffs): void {
  if (USER_ID.test(channel)) {
    throw new CommsError('USAGE', `"${channel}" is a user id: a post goes to a conversation id`, {
      hint: handoffSentence(
        handoffs.own(['channels', '--workspace', alias]),
        (command) => `For a direct message use the DM’s id (D…), which ${command} and slack_channels list.`,
        { instead: 'For a direct message use the DM’s id (D…), which slack_channels lists.' },
      ),
      details: { channel, reason: 'user-id' },
    });
  }
  if (CONVERSATION_ID.test(channel)) return;
  throw new CommsError(
    'USAGE',
    `"${truncateDisplay(channel, 60)}" is not a conversation id: Slack is given a conversation’s id, never its name`,
    {
      hint: handoffSentence(
        handoffs.own(['channels', '--workspace', alias]),
        (command) =>
          `Pass the conversation’s id — a channel’s C… or G…, a DM’s D… — exactly as ${command} and slack_channels list it.`,
        {
          instead: 'Pass the conversation’s id — a channel’s C… or G…, a DM’s D… — exactly as slack_channels lists it.',
        },
      ),
      details: { channel, reason: 'not-a-conversation' },
    },
  );
}
