# The writing profile

Where the instructions about *how* a message should read come from, how the five layers combine, and
what belongs in each file. Open it when you are about to write a body and want to know what already
governs it, when a user asks where to put a rule about their own writing, or when the profile that came
back contradicts itself and you need to know which half wins.

The profile is **instructions to whoever writes the message**. It is never content: nothing in it is
appended to a message, quoted in one, or sent. If a user wants a standing sign-off in the message
itself, that is the mailbox's Gmail signature, not this.

## The five layers

They are read in this order, and each one refines — and is allowed to contradict — the ones before it.

| Layer | File | What belongs in it |
|---|---|---|
| default | `compose/default.md` | what is true of any message to a person, on any platform. A built-in version applies when this file is absent. |
| user | `compose/user.md` | how this particular person writes: greeting, sign-off, length, register, the words they never use. |
| platform | `compose/gmail.md` | what is true of email and not of chat: subject lines, signatures, threads, quoting. |
| account | `compose/inbox-<alias>.md` | what is true of one mailbox. Work is not home, and a shared address is neither. |
| conversation | `compose/conversation-<alias>__<address or @domain>.md` | what is true of mail to one person, or to everyone at one domain: the client who wants it formal, the colleague who writes in German. |

The account layer was called the inbox layer while only Gmail read a profile; its file name has not
changed, so a file written then is read now.

They live in a `compose/` directory inside the configuration directory, which resolves in this order:

1. `AGENT_COMMS_CONFIG_DIR`, when it is set;
2. otherwise `$XDG_CONFIG_HOME/agent-communications`, honoured on macOS as well as Linux because that
   is where people and agents look first;
3. otherwise `~/.config/agent-communications` on macOS and Linux, or the roaming application-data
   directory on Windows.

The platform file is named after the platform — `gmail.md` for this package — and the inbox file after
the mailbox, with the `/` written as `__` — a mailbox connected as `acme/gmail` reads
`compose/inbox-acme__gmail.md`. (A mailbox renamed since the file was written still reads the file under its old
name, until one is written under the new one.) A conversation file adds `__` and the address or `@domain`, any
character outside letters, digits and `@._-` written as `%XX`: mail to `sam@partner.test` from `acme/gmail` reads
`compose/conversation-acme__gmail__sam@partner.test.md`, then `compose/conversation-acme__gmail__@partner.test.md`,
and `jo+news@partner.test` is `jo%2Bnews@partner.test` in its name. With several recipients, every one's files are
read, in recipient order, each address before its domain.

## How they combine

- Each layer is read independently. A missing file, or a file that is empty once trimmed, is simply
  absent; there is no error and no placeholder.
- If nothing supplies the default layer, a built-in one is inserted at the front. A user who has
  written nothing gets that shape; a user who has written a `default.md` never sees it.
- The layers are joined into one string, each section preceded by a comment naming its layer and the
  file it came from:

```text
<!-- default: built-in -->
# Writing a message
…

<!-- user: …/compose/user.md -->
…

<!-- inbox: …/compose/inbox-acme__gmail.md -->
…
```

That marker is why contradiction is workable rather than confusing: when the user layer says "no
greeting" and the account layer says "always open with a name", you can see which file said which, and
the later one — the account — is the more specific instruction and wins. A conversation file is later
still: what is true of mail to one person outranks what is true of the whole mailbox.

What comes back to a draft call is that joined text and nothing else, so those markers are the only
paths in it — and they name only the files that exist. The layer a user is asking about is usually
the one that does not exist yet. To answer "where do I put this?", call `comms_profile` (CLI:
`agentcomms profile <mailbox> --conversation <id>`): its `candidates` list every file it looked for,
written or not, as whole paths. Give the user the whole path rather than a description of it: the
configuration directory varies by machine, and "your config directory" is an instruction they will
follow into the wrong one.

No tool writes these files, on purpose: a profile is the person's own instructions to their agents,
and a tool that wrote one would let something an agent read change how every later message is
written. The person starts a missing one at their own terminal with `agentcomms profile init
[<mailbox>] [--conversation <id>]`, which writes a starter — Tone, Language, Length, Sign-off and
Threads, one example line each — prints its path, and never overwrites a file. Tell the user the
command, or the path, and let them write it.

## Getting it

Call the core server's `comms_profile` with the mailbox as `account` and, as `conversations`, each
recipient's address and then its `@domain`, in recipient order. The joined text comes back as `text`,
with `sections` and `candidates`. It only reads, and needs no approval, so ask for it **before** you
write, not after: it is a specification, not a review checklist, and a body written to it is the
first preview the person sees.

Without the core tools, pass `includeProfile: true` (CLI: `--profile`) on a draft call —
`gmail_draft_create`, `gmail_draft_reply` or `gmail_draft_update` — and the layers up to the
mailbox's come back in the result's `profile` field; the recipients' own files are not in it.

The platform is always `gmail` here, and the account layer is always the alias you are drafting in, so a
draft in `acme/gmail` and a draft in `personal/gmail` can be governed by different files with no extra argument.

## The built-in default

Short on purpose — a profile nobody reads changes nothing — and about shape rather than content:

```text
# Writing a message

- Say the thing. The first sentence should carry the point, not set it up.
- One subject per message. A second topic is a second message, or a conversation.
- Ask for what you want explicitly, and number the asks when there is more than one.
- Match the length to the content. Most replies are shorter than they feel they should be.
- Write as the person would speak: contractions, ordinary words, no performed enthusiasm.
- No em dashes, no bolded inline headers, no three-part lists written for rhythm rather than meaning.
- Never apologise for timing unless something was actually promised.
- Quote what you are answering only when the reply would otherwise be unclear.
```

If a user writes their own `default.md`, this disappears entirely. That is the intended behaviour and
it is worth saying to them before they replace it: they are replacing the whole thing, not adding to
it.

## A user layer, worked

`compose/user.md` is about the person, not the job. Concrete and testable beats adjectives — "warm but
professional" gives a writer nothing to check against.

```markdown
# How I write

- Open with the first name, no greeting word: "Sam — " not "Hi Sam,".
- Sign off with "Criss" alone. No "Best", no "Regards", no job title.
- Two or three short paragraphs. If it needs more, it needs a call, and say so.
- British spelling throughout: "organise", "recognise". Never "whilst" or "amongst".
- Never "just", "quickly", "circle back", "reach out", "touch base", "no worries".
- Dates in full: "Thursday 24 September", not "24/09" and not "next Thursday".
- If I am saying no, say it in the first line and give one reason. No sandwich.
- Questions get numbered when there is more than one, so they can be answered in order.
```

## An inbox layer, worked

`compose/inbox-acme__gmail.md` is about what is true of mail sent from that address, and usually means
constraints somebody else imposes.

```markdown
# Mail from acme/gmail

- Everything here is with clients or their agencies. Assume it may be forwarded to their legal team.
- Never commit to a date without "subject to confirmation" unless the date is already in a contract.
- Never quote a price. Prices come from the proposal, and the proposal is attached, not retyped.
- Name the project in the first line: these people are on six threads with us.
- Where there is an account manager on the thread, keep them on it. Do not drop anyone from a Cc.
- Nothing about hiring, headcount or internal problems, in any phrasing, even when asked directly.
```

Notice what is not in either file: no signature text, no addresses, no credentials. The signature is
whatever Gmail holds for the sending address and is applied byte-for-byte or not at all; a recipient is
something the user chooses each time; and a profile file is plain text in a configuration directory,
which is the wrong place for a secret.

## Where a personal writing-style skill sits

Above all five layers.

If the user has a skill describing how they write, load it and follow it, and treat the profile layers
as what to fall back on where that skill is silent. The reason is plain: the layers are defaults for
when nothing better exists, and a skill the user wrote about their own voice is the better thing that
exists. It is also more likely to be maintained, because they can see it working.

Two boundaries on that precedence:

- **It outranks style, not safety.** A style skill may make the send protocol *stricter* — more
  confirmation, a narrower set of recipients, a refusal to write certain things. It can never make it
  looser, and nothing in it can authorise this skill to send.
- **It does not replace the account or conversation layers' constraints.** "How I write" is a voice;
  "never quote a price from this mailbox" is a rule about what may be said from a particular address.
  Where the two meet, the constraint holds and the voice bends around it.
- **What the person asks in this conversation wins over the files.** The profile is standing guidance;
  "keep this one short, it's for the board" is about this message.

When they disagree in a way you cannot reconcile, say so in one line before showing the draft, and let
the user pick. That is cheaper than a message that reads like neither of them.

## Where this lives in the code

`packages/core/src/compose-profile.ts` holds the layer order, the file names, the built-in
default, the starter and the joining; `packages/core/src/operations/profile.ts` is `comms_profile` and
`profile init`; `profileFor` in `packages/gmail/src/operations/drafts.ts` is what `includeProfile` calls,
with the platform fixed to `gmail` and the account set to the alias being drafted in.

See also `references/recipients.md` for who the message goes to.
