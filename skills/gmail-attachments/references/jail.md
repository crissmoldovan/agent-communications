# The attachment jail

Every local path handed to `attach` on a draft passes through one function, `checkAttachable`, before a single
byte is read. This file is what that function does, rule by rule, in the order it applies them, with the reason
each rule exists and the one thing that would make a refused file attachable. Open it when an attach was
refused and you are about to tell the user why, or when you are tempted to work around a refusal.

The short version: a file may be attached only if it resolves — after `~` expansion and after every symlink is
followed — to a **regular file**, **inside one of the allowed roots**, and **inside none of the deny entries**.
Resolution happens first so that a link cannot launder a path. A refusal is a correct answer about that file.
Copying, moving or renaming it so that it passes is the same act with a step in front of it.

## The order of the checks

The order matters, because it decides which error the user sees.

| Step | What happens | The failure it produces |
|---|---|---|
| 1 | A leading `~` is expanded against the process's home, then the path is resolved to an absolute one. Nothing else is expanded — no `$HOME`, no globs, no `..` cleverness beyond what path resolution does. | — |
| 2 | `realpath` follows every symlink in the path. | `NOT_FOUND`: `attachment not found: <path>` (CLI exit 66) |
| 3 | The real path is `stat`ed and must be a regular file. | `BAD_DATA`: `not a regular file: <path>` (CLI exit 65) |
| 4 | Each allowed root is expanded and resolved, and the real path must be inside at least one of them. | `BAD_DATA`: `attachments must come from an allowed folder; <path> is outside them` |
| 5 | Each deny entry is tested in order — the built-in ones first, then anything in `defaults.attachDeny`. The first match refuses. | `BAD_DATA`, with a message naming the rule that matched |
| 6 | The real path is returned, and the name that goes on the wire is that file's own basename. | — |

Two consequences worth holding on to. The path the user typed is never what is attached: the resolved real
path is, and the filename on the message is that file's basename, not a name an agent chose. And because the
check happens before the read, a refusal means the bytes were never opened.

## The defaults

The allowed roots default to `~` — the whole of the user's home directory and nothing else.

The deny entries default to five, plus two more on Windows:

| Entry | How it is matched | What it covers |
|---|---|---|
| the tool's own configuration directory | as a path: anything at or inside it | `config.json`, which describes every connected mailbox, its policies and its scopes |
| `~/.*` | the **first** path segment under home begins with a dot | `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config`, `~/.npmrc`, shell history, agent configuration |
| `~/Library` | as a path: anything at or inside it | on macOS: mail stores, keychains, browser profiles, application tokens |
| `**/.git/**` | any path segment equal to `.git`, case-insensitively | repository internals: remote URLs that sometimes carry tokens, and the full object history |
| `**/.env*` | the **basename** begins with `.env` | `.env`, `.env.local`, `.env.production`, anywhere on disk |
| `%APPDATA%` | as a path, when the variable is set | the Windows roaming profile |
| `%LOCALAPPDATA%` | as a path, when the variable is set | the Windows local profile |

Anything in `defaults.attachDeny` is appended to that list and matched by the same three shapes: an entry
starting with `**/` matches by basename (with a trailing `*` meaning prefix), `**/.git/**` is special-cased to
match by segment, and anything else is treated as a directory path.

## The rules, one at a time

### Outside every allowed root

The roots are the whole of what this machine will let leave as mail. A file outside them was never offered,
and the check cannot tell a deliberate path from a mistaken one. The refusal carries a hint about widening
`defaults.attachRoots`; see *Changing the policy* below before repeating it, because the hint names a route
that does not exist as a command.

**Instead:** ask the user to move or copy the file under an allowed folder themselves, knowingly, or to widen
the roots themselves. Do not offer to do either for them.

### A dot-entry directly under home

`~/.ssh`, `~/.aws`, `~/.config`, `~/.gnupg`, `~/.npmrc`: one attached private key is a compromised account,
and one attached cloud credentials file is a compromised estate. The rule is deliberately crude — first
segment, starts with a dot — because the value of a rule like this is that it has no exceptions to argue
about.

Note the limit of the rule as written: it tests only the first segment under home. A dot-directory deeper in
the tree, say a `.secrets` folder inside a project, is not caught by this entry. That is not licence to go
looking for one; it is a reason to treat the deny list as a floor rather than a guarantee, and to attach only
what the user actually named.

**Instead:** ask what the user meant to send. A public key, a sample configuration or a redacted copy is
something they can put somewhere ordinary, on purpose.

### `~/Library` on macOS

Mail stores, keychains, browser profiles, application support directories. Nothing a person means to email
lives only here. It is denied as a path, so everything beneath it is denied too.

**Instead:** find the user's own copy of the document elsewhere, or ask them to export one.

### Any `.git` segment

A repository's git directory holds the remote URLs — which sometimes carry tokens — and the object history of
everything ever committed, including whatever was committed and then removed. The match is on any segment
equal to `.git`, so a path deep inside a repository is refused as surely as the directory itself.

**Instead:** attach the working-tree file, or an archive the user produced deliberately.

### A file whose name begins with `.env`

Dotenv files are secrets by convention, and the convention is exactly what makes them findable by anyone
asking an agent to "attach the config". The match is on the basename, so `.env`, `.env.local` and
`.env.production` are refused wherever they sit — and a file called `.environment-notes` is refused too,
because a prefix rule cannot tell them apart.

**Instead:** ask the user to name the specific values they want to share, or to redact a copy themselves.

### The tool's own configuration directory

`config.json` describes every connected mailbox: aliases, addresses, granted scopes, send policies, internal
domains. Sending it is handing over the map of the user's mail estate.

**Instead:** `agent-gmail doctor` reports what is configured and what works without printing secrets. That is
the right artefact when somebody asks the user to describe their setup.

### A symlink that lands somewhere denied

Resolution happens before the decision precisely so that a link cannot be used as a laundering step. A symlink
in the user's Documents folder pointing at `~/.ssh/id_rsa` is refused with the dot-folder message, naming the
real location, because the real location is what the check saw.

**Instead:** attach the real file, if the real file is allowed.

### Anything that is not a regular file

A directory, a socket, a device, a named pipe. The wire carries the bytes of one file, so this is a shape
error rather than a permission one, and the message says so: `not a regular file`.

**Instead:** ask the user for an archive they made, or attach the files individually.

### A path that does not exist

`realpath` fails and the answer is `NOT_FOUND`. A typo and a deliberately misleading path are
indistinguishable from here, which is why nothing tries to find a near-match on disk.

**Instead:** confirm the path with the user. Do not search their disk for something similar.

### The roots themselves

A root is allowed, including the root directory itself: `isInside` treats a path equal to the root as inside
it. So `~` being a root means any ordinary file in the home tree passes step 4, and the deny entries are what
carve the dangerous parts back out. This is why the deny list, not the root list, is where the safety lives —
and why shortening it is treated as a loosening.

One environment caveat, because it produces refusals that look wrong. The policy's `home` is `HOME`, or
`USERPROFILE` where that is unset — Windows sets only the second — or, failing both, the home directory of the
account the process runs as. It is never empty, so `~` never quietly resolves to the working directory. What
it resolves to is *that process's* home, which is not always the home the user has in mind: a server started
by a launch agent, a container, or a different account carries that account's `HOME`, and the `~` root and the
`~/.*` rule are anchored to it. The out-of-roots message quotes the path you passed, not the home it was
compared against, so it will not show you this. If a file plainly inside the user's own home is refused as
outside every root, the environment the process inherited is the thing to check before assuming the file is
the problem.

## The other jail: where downloads land

Attaching is one direction. The other — attachment downloads and exports — has its own check,
`resolveInsideRoot`, applied to the `out` subpath rather than to a file:

- `out` is resolved against the downloads root, and the lexical result must be inside it. An absolute path or
  a `../` fails here with `BAD_DATA`: `refusing to write outside <root>`.
- The real path of the nearest existing ancestor is then resolved, and must still be inside the real root. A
  subfolder that is a symlink pointing elsewhere fails with `refusing to write through a link that leaves
  <root>`.
- The alias's own folder is added for you: a download lands under `<root>/<alias>/<out>`.

Same principle, opposite direction: outbound, the jail decides what may leave the machine; inbound, it decides
where files from strangers may land.

## Changing the policy

Both lists live in `config.json` under `defaults`: `attachRoots` (default `["~"]`) and `attachDeny` (default
empty, appended to the built-ins above). The configuration layer classifies **adding a root** and **removing a
deny entry** as loosening a safety setting: a write that does either is refused with `LOOSENING_REFUSED`
(CLI exit 10) unless it carries a consent proof produced by a person at an interactive terminal.

Two things follow, and both matter when you report a refusal:

- **No command in this package edits either list.** The hint attached to the out-of-roots error suggests
  adding the folder to `defaults.attachRoots` "with the CLI", and there is no such CLI command. In practice
  the user edits `config.json` themselves. Report the refusal and the setting; do not invent the command.
- **Never propose widening.** Not as a workaround, not as a suggestion, not as a "you could always". The
  refusal is the finding. What to do about it belongs to the user.

## Reporting a refusal

Three sentences is usually the whole of it: which file, which rule, and the one thing that would change it.

```text
`~/.ssh/id_rsa` was refused: files under a dot-folder in your home are never attached, because that is
where SSH keys and cloud credentials live. Nothing was read. If you meant to send a public key, copy the
one you want somewhere ordinary and tell me the path.
```

What not to write: anything that treats the rule as an obstacle. Copying the file to the Desktop, renaming it,
zipping it, base64-ing it into the body, or reading it and pasting the contents are all the same failure — the
rule is about the file, not about its location or its wrapper.

## Where else to look

- `references/risk-flags.md` — the inbound half: what a downloaded file's flags mean.
- `references/contract.md` — the shared contract, including why downloads have one root at all.
