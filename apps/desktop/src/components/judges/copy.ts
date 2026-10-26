import type { AiProvider } from '../../ipc.ts';

/*
 * The words of the Judges rows, the two setup dialogs and Settings → AI providers (0.32.0), as the owner's prototype of
 * 2026-10-26 gives them (docs/prototypes/2026-10-26-0320: Main, JevSetup, LocalModel, Providers). Where the prototype
 * says something the event service does not do, the words say what it does.
 */

export const JUDGE_ROWS_COPY = {
  intro:
    'A judge reads a message a rule has matched, and answers the rule’s question, such as “Is this asking me for something?”. A rule can use a judge once you turn it on here.',
  keysAreKept: 'Keys are kept in Settings → ',
  aiProviders: 'AI providers',
  offAtOnce: '. Turning a judge off applies at once.',
  on: 'On',
  notSetUp: 'Not set up',
  setUp: 'Set up…',
  change: 'Change…',
  turnOff: 'Turn off',
  turnOffBody:
    "Decisions waiting on its judges are cancelled, and its rules can't call it until it is turned on again.",
  jev: {
    name: 'Jev, by TypeSafe',
    where:
      'A hosted model made for yes-or-no questions. It sees only the parts of a message a rule keeps, such as the sender and the subject.',
    needsKey: 'Needs a key from TypeSafe or OpenRouter.',
    through: 'Through',
    model: 'Model',
  },
  local: {
    name: 'A local model server',
    where: 'A model you run yourself on this Mac, such as Ollama. Nothing leaves the Mac.',
    model: 'Model',
  },
  laya: {
    notAvailable: 'Not available yet',
    body: "Laya will run inside this app, with no account and nothing leaving this Mac. It comes in a later release; there's nothing to set up today.",
  },
  unreadable: 'Its state could not be read.',
} as const;

/** "You have an OpenRouter key already.", for the providers that have one; nothing when none does. */
export function keysAlready(keys: Readonly<Record<AiProvider, boolean>> | null): string | null {
  if (keys === null) return null;
  if (keys.typesafe && keys.openrouter) return 'You have TypeSafe and OpenRouter keys already.';
  if (keys.openrouter) return 'You have an OpenRouter key already.';
  if (keys.typesafe) return 'You have a TypeSafe key already.';
  return null;
}

/** `Turn off <name>?` */
export function turnOffJudgeTitle(name: string): string {
  return `Turn off ${name}?`;
}

export const JEV_SETUP_COPY = {
  title: 'Set up Jev',
  changeTitle: 'Change Jev',
  body: "Jev answers a rule's yes-or-no question. Choose how to reach it.",
  connectThrough: 'Connect through',
  options: {
    openrouter: {
      label: 'OpenRouter',
      hasKey: 'Your OpenRouter key is added. OpenRouter bills your OpenRouter account.',
      noKey: 'No OpenRouter key yet.',
      host: 'openrouter.ai',
      sees: "Only the parts of a message each rule keeps, sent to openrouter.ai, which passes them to TypeSafe's Jev. Not your mailbox, and never a message no rule matched.",
    },
    typesafe: {
      label: 'TypeSafe, directly',
      hasKey: 'Your TypeSafe key is added. TypeSafe bills your TypeSafe account.',
      noKey: 'No TypeSafe key yet.',
      host: 'api.typesafe.ai',
      sees: 'Only the parts of a message each rule keeps, sent to api.typesafe.ai. Not your mailbox, and never a message no rule matched.',
    },
  },
  addOne: 'Add one in Settings → AI providers',
  keyAdded: 'Key added',
  noKey: 'No key',
  noKeys: 'Add a TypeSafe or OpenRouter key first. Jev reaches TypeSafe with one of them.',
  openProviders: 'Open AI providers',
  model: 'Model',
  whatJevSees: 'What Jev sees',
  budget: 'At most 60 calls an hour, two at a time, for every rule together.',
  cancel: 'Cancel',
  turnOn: 'Turn on Jev',
  save: 'Save',
  unreadableKeys: 'Your keys could not be read.',
} as const;

export const LOCAL_SETUP_COPY = {
  title: 'Set up a local model server',
  changeTitle: 'Change the local model server',
  body: 'Use a model running on this Mac as a judge. Nothing leaves the Mac.',
  whatYouRun: 'What you run',
  kinds: { ollama: 'Ollama', other: 'Something else' },
  addresses: { ollama: 'http://127.0.0.1:11434', other: 'http://127.0.0.1:8080' },
  address: 'Address',
  addressHint:
    "Only an address on this Mac: 127.0.0.1 or [::1], with its port. The server must answer Ollama's System One requests, as Ollama does.",
  addressWrong: 'Give an address on this Mac, such as http://127.0.0.1:11434.',
  model: 'Model',
  modelHint: 'The model the server runs, such as nimble.',
  modelWrong: 'A model is named with letters, digits and . _ : / - only.',
  defaultModel: 'nimble',
  cancel: 'Cancel',
  turnOn: 'Turn on',
  save: 'Save',
} as const;

export const PROVIDERS_COPY = {
  title: 'AI providers',
  body: "Keys for the hosted judges. A key is kept in this Mac's keychain, and once it's saved, it's never shown again: you can replace it or remove it.",
  keyAdded: 'Key added',
  noKey: 'No key',
  addKey: 'Add key…',
  replace: 'Replace…',
  remove: 'Remove…',
  saveKey: 'Save key',
  cancel: 'Cancel',
  noAccount: 'No account yet? ',
  usedByJev: 'Used by Jev',
  notUsed: 'Not used by a judge yet',
  footer: 'Removing a key that a judge uses turns that judge off, and the app tells you which one first. ',
  setUpIn: 'Set the judges themselves up in ',
  eventsJudges: 'Events → Judges',
  providers: {
    typesafe: {
      name: 'TypeSafe',
      where: 'The makers of Jev. A TypeSafe key reaches Jev directly.',
      getKey: 'Get a key from TypeSafe',
      /** TypeSafe's console, which its quickstart names for keys (read 2026-10-26); `links.rs` opens exactly this. */
      keys: 'https://console.typesafe.ai/keys',
    },
    openrouter: {
      name: 'OpenRouter',
      where: 'One account for many models, Jev among them. OpenRouter bills your OpenRouter account.',
      getKey: 'Get a key from OpenRouter',
      /** OpenRouter's key settings, which its Jev page names (read 2026-10-26); `links.rs` opens exactly this. */
      keys: 'https://openrouter.ai/settings/keys',
    },
  },
  unreadable: 'Your keys could not be read.',
  removeBodyUsed: (name: string) =>
    `Jev uses your ${name} key. Removing it turns Jev off through ${name}: it answers nothing until you add a key again.`,
  removeBodyUnused: 'No judge uses it.',
} as const;

/** `TypeSafe key`, the field's label. */
export function keyLabel(name: string, replacing: boolean): string {
  return replacing ? `New ${name} key` : `${name} key`;
}

/** `Paste your TypeSafe key`, the field's placeholder. */
export function keyPlaceholder(name: string): string {
  return `Paste your ${name} key`;
}

/** `Remove your OpenRouter key?` */
export function removeKeyTitle(name: string): string {
  return `Remove your ${name} key?`;
}
