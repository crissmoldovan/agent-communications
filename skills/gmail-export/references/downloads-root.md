# The downloads root

Everything this package writes from a mailbox — exported messages and threads, downloaded attachments, the
manifest that records them — lands under one directory. This file is where that directory is, how a path is
proved to stay inside it, what the layout looks like, why the setting is a safety boundary rather than a
preference, and what moving it actually takes. Open it when an export or download was refused a location, or
when the destination is inconvenient and moving it starts to look reasonable.

## Where it is

| Case | The root |
|---|---|
| Default | `~/Downloads/agent-communications` |
| `defaults.downloadsDir` set in the configuration | That directory, with a leading `~` expanded against the process's home |

Nothing else moves it. In particular the environment variables that relocate the package's other directories —
the configuration directory, the state directory, the secret store, the managed runtime data — have no effect
here. The downloads root is derived from the home directory and the application name, or from that one config
key.

The root is created before use with owner-only permissions, and an existing directory whose permissions are
looser is **tightened** rather than accepted. Every directory created beneath it is `0700`; every file written
into it is `0600`.

One caveat about the configured value, because it produces paths that look wrong: only a leading `~` is
expanded, and it is expanded against `HOME`, then `USERPROFILE`, then the home directory the operating system
reports — so a `~` always lands under a real home, on Windows too. Everything else is taken exactly as
written, which means a **relative** value is resolved against the process's working directory: wherever the
MCP client or the shell happened to start the package, and not necessarily the same place twice. If exports
are appearing somewhere unexpected, read `defaults.downloadsDir` first and check that it is absolute or
starts with `~`; then check the mailbox and `out` segments in the layout below.

## The layout

```text
<root>/<organisation>/<platform>/exports/<subject-slug>.md          an export, by default
<root>/<organisation>/<platform>/<out>/<subject-slug>.json          an export with out
<root>/<organisation>/<platform>/<out>/manifest.json                one per download call
<root>/<organisation>/<platform>/<out>/<date>_<sender>_<subject>/   one folder per downloaded message
```

Points worth knowing:

- **The mailbox name is always the first two segments** — it is `organisation/platform`, so `acme/gmail`
  becomes `acme/gmail/…` — and they are added for you. `out` never replaces them, so
  files from two mailboxes never mix.
- **Exports default to an `exports` subfolder**; downloads default to the mailbox's folder itself.
- **A download makes one folder per message**, named from facts about that message: the date, a slug of the
  sender's address, and a slug of the subject. Slugs are lower-case letters and digits joined by hyphens, and
  fall back to `undated`, `unknown` and `no-subject`.
- **`manifest.json` sits at the call's directory**, not in the per-message folders. It records the time, the
  inbox, every file with its hash and source message, everything skipped, and the total bytes. A second
  download into the same `out` **rewrites** it, so use a different subfolder when the record matters.
- **Nothing is ever overwritten.** Files are created with an exclusive open that refuses to follow a symlink
  at the final component, so a name already taken becomes `name-2.ext` and a planted link writes nothing.

## How `out` is jailed

`out` is a **subpath inside the root** on both surfaces — the MCP tools and the CLI. It is proved, not
trusted, in two steps:

1. **Lexically.** The path is resolved against the root, and the result must be inside it. An absolute path
   fails here, because resolving an absolute path against a base yields the absolute path itself. So does any
   `..` that escapes. The refusal is `BAD_DATA`: *refusing to write outside `<root>`* (CLI exit 65).
2. **After symlinks.** The real path of the nearest **existing** ancestor is resolved and must still be inside
   the real root. A subfolder that is a symlink pointing elsewhere fails here, with `BAD_DATA`: *refusing to
   write through a link that leaves `<root>`*.

The root itself is resolved before the comparison, so a root that is itself a symlink is fine — it is the
escape from the root that is refused, not the shape of the root.

| What you pass | What happens |
|---|---|
| `invoices` | `<root>/<organisation>/<platform>/invoices` |
| `2026/september` | Nested subfolders, created as needed |
| `../../Projects/acme/mail` | Refused, lexically |
| An absolute path | Refused, lexically |
| A subfolder that exists and is a symlink out of the root | Refused, after resolution |
| A subfolder that exists and is a symlink **within** the root | Allowed — it still lands inside |

A refusal is the correct answer with a next step, not an obstacle. The next step is a folder name, or the
user's decision to put the file elsewhere themselves.

## Why the directory is a safety setting

Not tidiness. Four reasons, and they compound:

- **One known place for files from strangers.** Attachments arrive from senders nobody vetted, with names the
  sender chose. Keeping every one of them under a single root is what makes "what has this thing written to my
  disk" a question with an answer.
- **It keeps mail out of everything else.** If an agent could choose the destination, "save that attachment to
  my project folder" would be one sentence away from writing a sender-controlled file into a source tree, a
  startup directory, or anywhere a later process reads without thinking.
- **It is the counterpart to the attachment jail.** Outbound, the jail decides which local files may leave as
  mail. Inbound, this root decides where files from mail may land. Either boundary is much weaker without the
  other: a writable destination anywhere on disk would be a way to place a file and then attach it.
- **The permissions only hold inside it.** The `0700` directories and `0600` files are applied to what this
  package creates under the root. A destination elsewhere inherits whatever that place already is.

## What changing it takes

The setting is `defaults.downloadsDir` in the user's `config.json`.

The configuration layer classifies a change to it as **loosening a safety setting** when the new value is set,
differs from the old one, and is **not inside** the old one. Narrowing — pointing it at a subdirectory of
where it already was — is not a loosening, and neither is clearing the setting, because clearing it returns to
the built-in default. A write that does loosen is refused with `LOOSENING_REFUSED` (CLI exit 10) unless it
carries a person's consent: a change approval they gave, or a challenge they typed back at a terminal.

Two things follow, and both belong in what you tell the user:

- **No tool and no command in this package changes it.** There is no MCP tool for it and no CLI subcommand
  for it. In practice the user edits `config.json` themselves. Do not invent a command, and do not offer to
  make the edit.
- **Never propose widening it to suit an export.** Not as a workaround, not as a suggestion. When the location
  is inconvenient, the honest move is to say exactly where the file went and let the user move it or change
  the root on their own terms.

## Reporting

What went where, in full, with the size — and nothing about the contents you have not read:

```text
Wrote the thread to
~/Downloads/agent-communications/acme/gmail/exports/phase-2-rollout-plan.md
(212 KB, md). Thread 18f2c9a0b1d4e5f6 in "acme/gmail".
```

And for a refusal:

```text
That `--out` was refused: it points out of the downloads root, and everything this writes stays inside it.
`out` is a folder name within the root — say which folder you meant and it will land at
~/Downloads/agent-communications/acme/gmail/<folder>/. If you want the file in your project, move it there
yourself once it is written.
```

Every download and every export is appended to the audit log with the inbox, the ids, the format or file
count, and the byte total. That log is the durable answer to what has been written, and it is a good reason to
keep the root where the user expects it.

## Where else to look

- `references/export-formats.md` — what each format contains, what it loses, and how truncation shows up.
- `references/contract.md` — the shared contract, including that a download directory is a safety setting.
