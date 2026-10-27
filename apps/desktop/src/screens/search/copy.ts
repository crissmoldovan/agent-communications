/**
 * Search on this machine's words (0.35.0, design 2026-10-26-local-search §8; the approved boards `Search`, `Person`
 * and `SettingsSearch` in `docs/prototypes/2026-10-26-messages-lifecycle`). Where a board drew what the design leaves
 * out — a short answer written by a model, summaries, sessions that ask too, a built-in model, people joined by a Slack
 * profile's address — the words say what is built instead: no agent searches (S13), meaning comes from the person's own
 * Ollama on this Mac (S9), and only the person joins a Gmail person and a Slack person (S5).
 */

/** Plural words, by count. */
export function counted(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}

/** A list in words: `a`, `a and b`, `a, b and c`. */
export function listWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

/** A size in the units a person reads: KB, MB, GB. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** The two parts of Messages (board `Search`): its list, and asking about past messages. */
export const MESSAGES_TABS_COPY = {
  label: 'Messages',
  all: 'All messages',
  ask: 'Ask about past messages',
} as const;

/** The words of Search (board `Search`). */
export const SEARCH_COPY = {
  heading: 'Ask about past messages',
  field: 'Ask about past messages',
  placeholder: 'Ask in your own words, such as: what did David ask about invoices?',
  ask: 'Ask',
  searching: 'Searching on this Mac…',
  tooLong: (limit: number) => `A question is at most ${limit} characters.`,
  refusedCharacter: "A question can't hold a line break, a tab, or an invisible or bidi character.",
  empty: 'Type what to look for, such as invoices or the staging site.',
  try: 'Try',
  examples: ['invoices', 'a meeting this week', 'the website'] as readonly string[],
  from: 'From',
  anyone: 'Anyone',
  when: 'When',
  windows: {
    kept: (days: number) => `Everything kept (${days} days)`,
    week: 'Last 7 days',
    today: 'Today',
  },
  state: 'State',
  anyState: 'Any state',
  amongBest: 'Among the best 50.',
  local: 'Searched on this Mac: nothing leaves it.',
  localWhy: 'No AI provider is asked, and no message goes anywhere.',
  wordsOnly: 'By words only:',
  noModel:
    'no local model is set up, so Ask finds the words you type, not what they mean. Set one up in Settings → Search on this Mac.',
  pending: (count: number) =>
    `${counted(count, 'kept message')} ${count === 1 ? "isn't" : "aren't"} searchable by meaning yet.`,
  count: (count: number) => counted(count, 'message'),
  looked: (looked: number, ms: number) =>
    `Looked through ${counted(looked, 'message')} on this Mac in ${(ms / 1000).toFixed(1)} seconds`,
  closest: 'Closest first',
  suggestion: 'A name in your question matches someone. Names prove nothing, so this is only a suggestion:',
  onlyFrom: 'Only from',
  fromChip: 'From',
  removePerson: 'Remove this filter',
  done: 'What was done',
  nothingRecorded: 'Agent Comms recorded nothing done with it.',
  open: 'Open its story',
  seePerson: 'See everything they asked',
  found: {
    both: 'Found by its words and by its meaning.',
    words: 'Found by its words.',
    meaning: 'Found by its meaning, not by the word.',
  },
  partial: 'Only part of it is kept: the agent saw a preview, not the whole message.',
  mismatch: 'In Slack it says one thing in the channel and another in its notification.',
  unrenderable: 'In Slack a part of it could not be shown.',
  sent: 'A reply Agent Comms sent',
  nothing: 'Nothing close to that in what Search keeps. Try other words, or a person’s name.',
  nothingNarrowed: 'Nothing close to that from whom and when you chose. Widen From or When.',
  nothingInState: 'None of the closest messages is in that state.',
  storyProblem: 'What was done with each could not be read:',
  coverage: (accounts: readonly string[], days: number) =>
    accounts.length === 0
      ? `Ask looks through what Agent Comms saw, kept ${days} days: no account is kept yet.`
      : `Ask looks through what Agent Comms saw: the messages agents read in ${listWords(accounts)}, and the replies sent, kept ${days} days. Messages agents didn’t read aren’t here.`,
  notEncrypted:
    'The words and names are kept encrypted. The words index and the vectors can’t be, so treat Search’s folder like your mail.',
  settings: 'Settings → Search on this Mac',
  off: 'Search on this Mac is off.',
  offEmpty: 'Nothing is kept, so there is nothing to ask about yet. Switch it on in Settings → Search on this Mac.',
  offKept:
    'Nothing new is kept. What was kept can still be asked about until its days pass, or until you delete everything.',
  needsNode: 'Search’s words index needs Node 22.18 or newer on this Mac.',
  unreadable: 'What Search answered could not be read.',
} as const;

/** The words of People (board `Person`). */
export const PEOPLE_COPY = {
  title: 'People',
  about: 'Everyone a kept message is from, in Slack and Gmail, and what each asked you.',
  back: 'People',
  none: 'No one yet.',
  noneHint:
    'A person shows here once an agent reads a message from them through Agent Comms, while Search on this Mac is on.',
  messages: (count: number) => counted(count, 'message'),
  lastWrote: 'Last wrote',
  joinedByYou: 'Joined by you',
  someone: 'Someone',
  about1: 'Everything they asked you, in Slack and Gmail, and what was done with it.',
  gmail: 'Gmail',
  slack: 'Slack',
  gave: 'gave the name',
  joinedAuto: 'One address or Slack user, seen in every account that has it.',
  joinedLinked: 'Joined as one person by you.',
  separateWhy: 'Not the same person? Separate them.',
  separate: 'Separate',
  separated: 'Separated at once: that address or Slack user now shows as a person of its own. You can join them again.',
  sameAs: 'Same person as',
  sameAsWhy:
    'Join a Gmail person and a Slack person you know are one. Names prove nothing, so only you join people; you can separate them again.',
  choose: 'Choose someone',
  join: 'Join',
  joined: 'Joined: they now show as one person. You can separate them again.',
  sameName: 'Someone else gave the same name. That proves nothing: join them only if you know they are one person.',
  sameNameJoin: 'Same person',
  name: 'Your name for them',
  nameWhy: 'The name you know them by. Only you set it, and it is kept encrypted.',
  save: 'Save',
  saved: 'Saved.',
  nameRefused: 'A name is 1 to 80 characters, with no line break or invisible character.',
  messagesIn: (count: number, days: number) => `${count === 1 ? 'message' : 'messages'} in ${days} days`,
  replied: 'replied',
  done: 'done',
  waiting: 'waiting for you',
  asked: 'What they asked',
  newest: 'Newest first',
  searchField: 'Search what they asked',
  searchPlaceholder: 'Search what they asked, such as invoices',
  search: 'Search',
  clear: 'Clear',
  matched: (count: number) => `${counted(count, 'message')} close to that, found on this Mac.`,
  askAll: 'Ask about all past messages',
  noMatch: 'Nothing they asked is close to that. Try other words.',
  nothingKept: 'Nothing they sent is kept any more.',
  more: 'Older messages are kept too.',
  showMore: 'Show more',
  footnote:
    'Each line is the message’s subject, or its first words. Open one for the message itself and everything that happened to it.',
  gone: 'Search no longer keeps this person.',
} as const;

/** The words of Settings → Search on this Mac (board `SettingsSearch`). */
export const SEARCH_SETTINGS_COPY = {
  title: 'Search on this Mac',
  about:
    'Keeps the words of messages agents read, and the replies sent, so you can ask about past messages in Messages and see what each person asked in People.',
  switchLabel: 'Search on this Mac',
  on: 'On',
  empty: 'Empty',
  keptLine: (messages: number, people: number, size: string, oldest: string | null) =>
    `${counted(messages, 'message')} from ${counted(people, 'person', 'people')} · ${size}${oldest === null ? '' : ` · since ${oldest}`}`,
  emptyLine: 'Nothing kept yet. New messages agents read are kept as they arrive.',
  waiting: (count: number) => `${counted(count, 'message')} waiting to be added.`,
  off: 'Off: nothing new is kept.',
  offKept: 'What was kept stays searchable until its days pass, or until you delete everything below.',
  offEmpty: 'Nothing is kept.',
  askOn: {
    title: 'Keep the words of messages on this Mac, to search them? Approve it',
    body: 'From now on, the words of new messages agents read in the accounts below, and the replies sent, are kept on this Mac, encrypted, for as long as Activity keeps its days. Activity keeps no message’s words; this would.',
    approved: 'Approved. New messages agents read are kept on this Mac, to search.',
  },
  switchedOff: 'Switched off at once. Nothing new is kept.',
  local: 'Searched on this Mac: nothing leaves it.',
  localWhy: 'No AI provider is asked, to make it searchable or to answer.',
  kept: 'What is kept',
  keptRows: [
    {
      term: 'The message’s words',
      detail:
        'A Slack message’s text; an email’s subject and the text an agent read, with quoted history left out. Never its attachments.',
    },
    {
      term: 'Who and where',
      detail: 'The sender’s address or Slack user, the name they gave, the account and the thread.',
    },
    { term: 'Replies sent', detail: 'The words of each reply Agent Comms sent, as what was done.' },
    {
      term: 'What was done',
      detail:
        'Not copied: it is read from Activity and the event service each time you look, so it is never out of date.',
    },
  ],
  coverage:
    'Only what Agent Comms already had in hand: messages agents read through it. Nothing is fetched for Search, and never WhatsApp or your own messages.',
  accounts: 'From these accounts',
  accountSwitch: (alias: string) => `Keep messages from ${alias}`,
  gmailLine: (address: string | null) => (address === null ? 'Gmail' : `Gmail · ${address}`),
  slackLine: (workspace: string | null) => (workspace === null ? 'Slack' : `Slack · workspace ${workspace}`),
  noAccounts: 'No Gmail mailbox or Slack workspace is connected yet.',
  askAccount: (alias: string) => ({
    title: `Keep ${alias}’s messages too? Approve it`,
    body: `The words of new messages agents read in ${alias} would be kept on this Mac, to search.`,
    approved: `Approved. New messages agents read in ${alias} are kept too.`,
  }),
  accountRemoved: (alias: string, deleted: number) =>
    `Left out at once: nothing new from ${alias} is kept${deleted === 0 ? '.' : `, and ${counted(deleted, 'kept message')} from it ${deleted === 1 ? 'was' : 'were'} deleted.`}`,
  howLong: 'How long',
  howLongLine: (days: number) =>
    `${counted(days, 'day')}, the same as Activity. Older messages are deleted as their days pass.`,
  howLongChange:
    'To change it, change how many days Activity keeps, with activity retention at a terminal: fewer days delete the older messages at once, and more are approved first.',
  model: 'How it’s made searchable',
  modelAbout:
    'A model your own Ollama runs on this Mac turns each message into a list of numbers, a vector, so Ask finds messages by what they mean: “invoice” also finds “bill”. Without one, Ask finds the words you type.',
  modelNone: 'Words only: no model is set up.',
  theModel: 'The model',
  where: 'Where it runs',
  its: 'Its state',
  states: {
    running: 'Running on this Mac',
    missing: 'Not downloaded yet',
    'remote-refused': 'Refused: Ollama would run it somewhere else',
    unreachable: 'Ollama isn’t answering',
    unexpected: 'That address doesn’t answer as Ollama does',
  },
  getIt: 'Get it in a terminal with:',
  checkAgain: 'Check again',
  localOnlyOff:
    'Ollama’s local-only mode isn’t set. Set OLLAMA_NO_CLOUD=1 where Ollama runs, so it never runs a model anywhere else.',
  choose: 'Model',
  address: 'Ollama’s address',
  addressHint: 'On this Mac only: http://127.0.0.1:<port> or http://[::1]:<port>.',
  addressRefused: 'Give http://127.0.0.1:<port> or http://[::1]:<port>: Search calls a model on this Mac only.',
  defaultAddress: 'http://127.0.0.1:11434',
  use: 'Use this model',
  wordsOnly: 'Words only',
  wordsOnlyApplied: 'Words only, at once: every vector was dropped.',
  askModel: (name: string, address: string) => ({
    title: `Make kept messages searchable by meaning with ${name}? Approve it`,
    body: `The words of each kept message would be sent to the model server at ${address}, on this Mac only, to make them searchable by meaning.`,
    approved: `Approved. Kept messages are made searchable by meaning with ${name}.`,
  }),
  download: (download: string, licence: string) => `${download} · ${licence}`,
  defaultModel: 'the default',
  again: 'Start again',
  rebuild: 'Rebuild',
  rebuildWhy: 'Makes every vector again from the kept messages. Ask keeps working meanwhile.',
  rebuildNeedsModel: 'Rebuild needs a local model: set one up above.',
  rebuilding: (made: number, pending: number) =>
    `Rebuilding: ${counted(made, 'vector')} made so far, ${counted(pending, 'message')} to go.`,
  rebuilt: 'Rebuilt: every kept message is searchable by meaning.',
  rebuildPaused: (pending: number) =>
    `Stopped with ${counted(pending, 'message')} to go: the rest are made as you use Search.`,
  rebuildBusy: 'Another run is going: try again in a moment.',
  stop: 'Stop',
  deleteAll: 'Delete everything…',
  deleteWhy: 'Removes the words, people and vectors Search keeps, and its key. The messages stay in Slack and Gmail.',
  deleteTitle: 'Delete everything Search keeps?',
  deleteBody: (messages: number) =>
    `The words and vectors of ${counted(messages, 'message')}, the people they came from, and Search’s key. Activity, the Queue, and the messages in Slack and Gmail aren’t touched.`,
  deleteAction: 'Delete',
  deleted: (files: number, key: boolean) =>
    `Deleted at once: ${counted(files, 'file')}${key ? ', and its key' : ''}. Search starts again with new messages.`,
  whereKept: 'Where it’s kept',
  folder: 'Folder',
  backups: 'Backups',
  backupStates: {
    excluded: 'Left out of Time Machine',
    'not-excluded': 'Not left out of Time Machine: a backup would keep it past its days',
    'not-checked': 'Not checked on this platform',
    unknown: 'Unknown',
  },
  disk: 'Disk encryption',
  diskStates: {
    on: 'FileVault is on',
    off: 'FileVault is off: the disk itself isn’t encrypted',
    'not-checked': 'Not checked on this platform',
    unknown: 'Unknown',
  },
  key: 'Its key',
  keyStores: {
    keychain: 'In the system keychain',
    file: 'In a file beside the data: the encryption protects only a copy of the folder alone',
  },
  lastFailure: 'The last message that could not be kept:',
  needsNode: 'Search’s words index needs Node 22.18 or newer on this Mac.',
} as const;
