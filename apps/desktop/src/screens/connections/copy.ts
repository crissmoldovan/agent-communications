/**
 * MCP connections' words (0.35.0): the owner-approved boards' copy — McpServers, AddConnection and Connection in
 * `docs/prototypes/2026-10-26-0340-rework` — less what the boards drew that core does not do (a key's last letters, a
 * snippet without the folder pins), and with what core says in their place.
 */

export const MCP_COPY = {
  title: 'MCP connections',
  sub: 'A connection is one place where an AI app uses Agent Comms: Claude Code in every folder, Claude Code in one project, Claude Desktop, and so on. You can have several for the same app. Each has its own name, its own parts and its own key.',
  faint:
    'An MCP server is a program an AI app starts to get more tools. Agent Comms is one server for all your accounts; a connection says which app starts it, where, and what it may reach.',
  helloLine: 'No connections yet.',
  hello:
    'Add one to let an AI app use your accounts. You choose the app, where it uses Agent Comms, and which parts and accounts it gets; then you approve it here.',
  add: 'Add a connection…',
  open: 'Open',
  openLabel: (name: string) => `Open ${name}`,
  notRead: "Core's answer about its connections could not be read.",
  partsNotRead: 'The parts a connection can have could not be read.',
  onItsOwn: 'Agent Comms on its own: setup, approvals and updates, and none of your accounts',
  lastUsed: 'Last used',
  notUsed: 'Not used yet',
  added: 'Added',
  twice: (other: string, app: string) =>
    `${other} is in the same place. ${app} starts both, so its agents see every Agent Comms tool twice.`,
  footer:
    'Removing a connection, or a part of one, applies at once. Adding a connection, or giving one more, shows you what it lets agents do and waits for your approval; on Windows and Linux you approve it in Terminal. An app sees a change after you restart it.',
  reach: 'Who can reach them',
  yes: 'Yes',
  no: 'No',
  yesLine:
    'Apps on this Mac, through your connections. That includes a Claude Code window on this Mac that you drive from your phone with Remote Control.',
  noLine:
    'Cloud sessions, such as Claude on the web or Claude Code in the cloud. They run on other computers, and Agent Comms runs only on this Mac.',
  testBanner: 'Test build: your apps start your real Agent Comms, not this test, and nothing can be changed here.',
  unreadable: (n: number) =>
    `${n === 1 ? 'One connection' : `${n} connections`} could not be read, so ${n === 1 ? 'it serves' : 'they serve'} nothing.`,
  addedSaid: (name: string, app: string, manual: boolean) =>
    manual
      ? `Added: ${name}. Paste its snippet into ${app}, then restart it.`
      : `Added: ${name}. Restart ${app} to use it.`,
  removedSaid: (name: string, app: string, manual: boolean) =>
    manual
      ? `Removed at once: ${name}. Its key stopped working. Take the snippet out of ${app}’s settings when you can.`
      : `Removed at once: ${name}. Its key stopped working. Restart ${app} to see the change.`,
  removedApprovedSaid: (name: string, app: string) =>
    `Approved and removed: ${name}. Its key stopped working. Restart ${app} to see the change.`,
  // Move to one entry (D16, §9.1): the person's step, never automatic.
  moveTitle: 'Move to one entry',
  moveLead:
    'Some apps still start Agent Comms as separate entries, one for each part. Moving them makes one connection for each app, which reaches exactly what its entries reached.',
  moveButton: 'Move to one entry…',
  moveAsk: 'Move each app’s separate entries into one connection? Approve it',
  moveAfter: 'The tools then appear under “agentcomms” in each app: allow them again there, and restart the app once.',
  moved: (name: string, app: string, n: number) =>
    `Moved ${n} ${n === 1 ? 'entry' : 'entries'} into the connection “${name}”${app === '' ? '' : ` (${app})`}.`,
  left: (name: string, path: string, why: string) => `Left “${name}” in ${path}: ${why}.`,
  undo: 'Undo',
  undoLabel: (name: string) => `Undo ${name}`,
  undoAsk: (name: string) => `Put ${name} back as separate entries? Approve it`,
  undone: (name: string) => `Undone: ${name} is separate entries again. Restart the app to see the change.`,
  notMoved: (message: string) => `Nothing was moved: ${message}`,
  approve: 'Approve',
  cancelled: 'Cancelled: nothing was changed.',
  prepareAgain: 'That approval could no longer be used, so it was prepared again: approve this one.',
  inTerminal: 'Confirm it in Terminal. This screen reads it again when you come back to this window.',
} as const;

export const ADD_COPY = {
  crumb: 'Add a connection',
  title: 'Add a connection',
  sub: 'Choose the app and where it uses Agent Comms, give it a name, choose what it may reach, then approve it. Nothing is written until you approve.',
  steps: {
    type: 'App',
    where: 'Where',
    which: 'Which app',
    name: 'Name',
    parts: 'Parts and accounts',
    review: 'Approve',
  },
  stepsLabel: 'Steps',
  whichApp: 'Which app is it for?',
  whichAppLead: 'Agent Comms writes the app’s settings itself for every app here but the last.',
  continue: 'Continue',
  back: 'Back',
  cancel: 'Cancel',
  manualTitle: 'Which app is it?',
  manualLead:
    'Agent Comms can’t write this app’s settings, so it gives you a snippet to paste into them. The app’s name is for you: it names the connection.',
  manualLabel: 'The app’s name',
  manualPlaceholder: 'For example LM Studio',
  manualProblem: 'Type the app’s name: it names the connection.',
  whereTitle: (app: string) => `Where should ${app} have it?`,
  whereLeadCode:
    'Claude Code can have Agent Comms everywhere, in one project only, or under another Claude profile. Each is a connection of its own.',
  whereLeadCodex: 'Codex keeps its settings in one folder, its Codex home. Most people have one.',
  places: {
    all: { name: 'Every folder', line: 'Your user settings, ~/.claude.json. Claude Code has it wherever you open it.' },
    project: {
      name: 'One project folder',
      line: 'Only Claude Code sessions in that folder have it. It is kept in your own settings, never in the project, so it never goes into git.',
    },
    profile: {
      name: 'Another Claude profile',
      line: 'A different Claude config folder, such as one you keep for a second Claude account.',
    },
    this: { name: 'This Codex', line: 'Your Codex settings, ~/.codex/config.toml.' },
    home: { name: 'Another Codex home', line: 'A different CODEX_HOME folder, with settings of its own.' },
  },
  folderLabel: 'Folder',
  folderPlaceholder: 'For example ~/work/acme-site',
  folderProblem: 'Type the folder whole, as it is on this Mac: for example ~/work/acme-site.',
  nameTitle: 'What should it be called?',
  nameLead: (name: string) =>
    `The name is how you’ll know it here, and in Activity: “used by ${name}”. You can change it later.`,
  nameLabel: 'Name',
  nameTaken: (name: string) => `You have a connection called “${name}” already. Choose another name.`,
  partsTitle: (name: string) => `What may agents in ${name} reach?`,
  partsLead:
    'Turn on the parts you want. Each one can be kept to one account, and Gmail to reading. You can change this later.',
  reviewTitle: 'Review and approve',
  askTitle: (name: string) => `Add ${name}? Approve it`,
  grantsLabel: 'What this lets agents do',
  reviewLead: (where: string) => `${where} could then:`,
  stillCant: 'They still can’t send anything without your yes, or change what agents may do in an account.',
  whereLabel: 'Where it goes',
  whereManual: (app: string) => `Nowhere: Agent Comms gives you a snippet, and you paste it into ${app} yourself.`,
  afterKnown: (app: string) => `Then restart ${app} to use it.`,
  afterProject: (folder: string) => `Then open ${folder} in Claude Code to use it.`,
  afterManual: (app: string) => `Then you paste a snippet into ${app}.`,
  elsewhere: 'On Windows and Linux, Approve opens Terminal and you approve it there.',
  notAdded: (message: string) => `Nothing was added: ${message}`,
  terminalManual:
    'Confirm it in Terminal: the snippet, with its key, is shown there once. Copy it from there, then press Done.',
  terminalKnown: 'Confirm it in Terminal, then press Done. Restart the app to use the connection.',
  terminalDone: 'Done',
  doneTitle: (name: string) => `${name} is added`,
  doneKnown: (app: string) => `Added. Restart ${app} to use it.`,
  doneProject: (folder: string) => `Added. Open ${folder} in Claude Code, or restart Claude Code there, to use it.`,
  doneManual: (app: string) => `Approved. Now paste it into ${app}.`,
  nothingToPaste: (app: string) =>
    `Agent Comms has put its key in ${app}’s settings, so there’s nothing to paste, and the app never shows it.`,
  notStarted: (detail: string) => `It did not start when Agent Comms checked it: ${detail}`,
  howManual: (app: string) => [
    `Open ${app}’s settings, where it lists MCP servers.`,
    'Add a server, and paste this. If it asks for one server only, paste the part inside “mcpServers”.',
    `Restart ${app}.`,
  ],
  done: 'Done',
  openIt: 'Open this connection',
  again: 'Add another',
  duplicate: (other: string, app: string) =>
    `${other} uses this place already. ${app} would start both, so its agents would see every Agent Comms tool twice. You could change that one’s parts instead.`,
  wide: (other: string, folder: string) =>
    `${other} is in every folder already, so Claude Code sessions in ${folder} would have both connections, and see two sets of Agent Comms tools.`,
  openOther: (name: string) => `Open ${name}`,
  footer:
    'Adding a connection shows you what it lets agents do and waits for your approval. Removing one later applies at once. An app sees a change after you restart it.',
} as const;

export const KEY_COPY = {
  title: 'What the key is for',
  body: (name: string) =>
    `It isn’t a password. Apps on this Mac start Agent Comms as you, so a key doesn’t keep anyone out. What it does: it tells Agent Comms which connection is calling, so Activity can say “used by ${name}”, and it lets you cut this connection off. Remove the connection, or replace its key, and the old key stops working.`,
  network: 'If Agent Comms one day becomes reachable over the network, this key becomes a real secret.',
} as const;

export const SNIPPET_COPY = {
  formats: { json: 'Most apps', toml: 'Codex', vscode: 'VS Code' },
  formatsLabel: 'Snippet format',
  formatHints: {
    json: 'For an app that lists servers under “mcpServers”, as Claude Desktop, Cursor and most others do.',
    toml: 'For a Codex config.toml.',
    vscode: 'For VS Code’s mcp.json, which lists servers under “servers”.',
  },
  copy: 'Copy',
  once: 'The snippet holds this connection’s key, shown this once: the app keeps no copy. Lost it? Open the connection and replace its key for a new snippet.',
} as const;

export const ONE_COPY = {
  rename: 'Rename…',
  renameTitle: 'Rename this connection',
  renameLabel: 'Name',
  renameNote: 'Activity uses the new name from then on. Renaming gives agents nothing more, so it applies at once.',
  save: 'Save',
  cancel: 'Cancel',
  renamed: (name: string) => `Renamed at once to “${name}”. Activity uses the new name from now on.`,
  sameName: 'Nothing was changed: that is its name already.',
  renameCancelled: (name: string) => `Cancelled: the name stays “${name}”.`,
  notRenamed: (message: string) => `Nothing was changed: ${message}`,
  about: 'About it',
  app: 'App',
  where: 'Where',
  entry: 'Its entry',
  addedOn: 'Added',
  manualApp: 'Manual: an app you paste a snippet into',
  running: 'Running now',
  runningFor: (client: string | null) => (client === null ? 'Running now' : `Running now for ${client}`),
  partState: { starting: 'starting', running: 'running', restarting: 'starting again', stopped: 'stopped' } as Record<
    string,
    string
  >,
  key: 'Key',
  issued: 'Issued',
  replace: 'Replace key…',
  replaceTitle: (name: string) => `Replace the key of ${name}?`,
  replaceManual:
    'The old key stops working at once, so the app loses these tools until you paste the new snippet into its settings.',
  replaceKnown: (app: string, file: string) =>
    `The old key stops working at once. Agent Comms writes the new one into ${file}; restart ${app} to use it.`,
  replaceButton: 'Replace key',
  replaceAtOnce: 'Applies at once: a new key gives agents nothing more.',
  replaced: 'Replaced at once. The old key stopped working.',
  replacedKnown: (app: string) => `Replaced at once. The old key stopped working. Restart ${app} to use the new one.`,
  replaceCancelled: 'Cancelled: the key stays as it was.',
  notReplaced: (message: string) => `The key was not replaced: ${message}`,
  newSnippet: 'The new snippet, shown this once',
  newSnippetNote: 'Paste it into the app’s settings in place of the old one, then restart the app.',
  hideSnippet: 'Done',
  parts: 'Parts and accounts',
  change: 'Change…',
  doneEditing: 'Done',
  editLead:
    'Taking something away applies at once. Giving more shows you what it lets agents do and asks you to approve it.',
  notIncluded: (names: string) => `Not included: ${names}.`,
  noCore: 'Agent Comms itself is not in this connection: it was made without it, at a terminal.',
  partsAtOnce: (what: string, app: string) => `Applied at once: ${what}. Restart ${app} to see the change.`,
  partsAsk: (name: string) => `Let agents in ${name} reach more? Approve it`,
  partsLead: (name: string) => `Agents in ${name} could then:`,
  partsApproved: (name: string, app: string) => `Approved. ${name} reaches more now. Restart ${app} to use it.`,
  partsNotChanged: (message: string) => `Nothing was changed: ${message}`,
  needOnePart: 'A connection keeps one part at least: remove the connection instead.',
  alreadySo: 'It was so already: nothing was changed.',
  recent: 'Recent activity',
  lastUsed: 'Last used',
  neverUsed: (app: string) =>
    `Nothing yet. When ${app} first calls Agent Comms through this connection, it shows here.`,
  usedBy: (name: string) => `In Activity, each call through it says “used by ${name}”.`,
  allActivity: 'All activity ›',
  undoTitle: 'Back to separate entries',
  undoLead: (app: string) =>
    `Each part becomes an entry of its own in ${app} again, as before 0.35, with its account and read-only, and this connection is removed. It is approved first.`,
  undoButton: 'Back to separate entries…',
  undoAsk: (name: string) => `Put ${name} back as separate entries? Approve it`,
  undone: (parts: string) => `Done: ${parts}. Restart the app to see the change.`,
  notUndone: (message: string) => `Nothing was changed: ${message}`,
  remove: 'Remove this connection',
  removeLead: (app: string) => `${app} loses these tools, and the key stops working at once.`,
  removeButton: 'Remove this connection…',
  removeTitle: (name: string) => `Remove ${name}?`,
  removeManual:
    'Its key stops working at once, so the app gets nothing more from it, even before you take the snippet out of its settings. Your accounts, and your other connections, stay as they are.',
  removeKnown: (app: string, file: string) =>
    `${app} loses every Agent Comms tool from this connection, and its key stops working at once. Agent Comms takes it out of ${file}. Your accounts, and your other connections, stay as they are.`,
  removeConfirm: 'Remove',
  removeAtOnce: 'Applies at once.',
  removeAtOnceKnown: (app: string) => `Applies at once. Restart ${app} to see the change.`,
  removeCancelled: (name: string) => `Cancelled: ${name} stays.`,
  // Core asks first where its entry shadows a wider one the agents in its folder would then use (0.35.0 review, H1).
  removeWider:
    'Its entry stands in front of a wider Agent Comms entry for every folder. Once it is gone, the agents in its folder use that one, and reach more. Core’s preview says what they would use.',
  removeAsk: (name: string) => `Remove ${name}, and let the agents in its folder reach more? Approve it`,
  notRemoved: (message: string) => `It was not removed: ${message}`,
  keptEntry: (name: string, path: string, reason: string) => `Its entry “${name}” in ${path} was left: ${reason}`,
  goneTitle: 'This connection is removed',
  back: 'Back to MCP connections',
  notShown: 'What is running for it now could not be read.',
} as const;

export const PARTS_COPY = {
  coreName: 'Agent Comms itself',
  coreLine: 'Setup, approvals and updates. Always included.',
  coreLabel: 'Agent Comms itself, always included',
  coreAbsent: 'Not in this connection: it was made without it, at a terminal.',
  which: 'Which accounts?',
  every: (n: number) =>
    n === 1 ? 'Every account: the one here, and any you add' : `Every account: all ${n}, and any you add`,
  only: (account: string) => `Only ${account}`,
  readOnly: 'Read-only',
  noAccounts: 'No account of it is set up here yet, so it reaches none until you add one.',
  events: 'Events covers all your workflows and the whole Queue, so there are no accounts to choose.',
} as const;
