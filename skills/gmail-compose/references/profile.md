# The writing profile

Where the instructions about *how* a message should read come from, how the four layers combine, and
what belongs in each file. Open it when you are about to write a body and want to know what already
governs it, when a user asks where to put a rule about their own writing, or when the profile that came
back contradicts itself and you need to know which half wins.

The profile is **instructions to whoever writes the message**. It is never content: nothing in it is
appended to a message, quoted in one, or sent. If a user wants a standing sign-off in the message
itself, that is the mailbox's Gmail signature, not this.

## The four layers

They are read in this order, and each one refines — and is allowed to contradict — the ones before it.

| Layer | File | What belongs in it |
|---|---|---|
| default | `compose/default.md` | what is true of any message to a person, on any platform. A built-in version applies when this file is absent. |
| user | `compose/user.md` | how this particular person writes: greeting, sign-off, length, register, the words they never use. |
| platform | `compose/gmail.md` | what is true of email and not of chat: subject lines, signatures, threads, quoting. |
| inbox | `compose/inbox-<alias>.md` | what is true of one mailbox. Work is not home, and a shared address is neither. |

They live in a `compose/` directory inside the configuration directory, which resolves in this order:

1. `AGENT_COMMS_CONFIG_DIR`, when it is set;
2. otherwise `$XDG_CONFIG_HOME/agent-communications`, honoured on macOS as well as Linux because that
   is where people and agents look first;
3. otherwise `~/.config/agent-communications` on macOS and Linux, or the roaming application-data
   directory on Windows.

The platform file is named after the platform — `gmail.md` for this package — and the inbox file after
the mailbox alias, so a mailbox connected as `work` reads `compose/inbox-work.md`.

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

<!-- inbox: …/compose/inbox-work.md -->
…
```

That marker is why contradiction is workable rather than confusing: when the user layer says "no
greeting" and the inbox layer says "always open with a name", you can see which file said which, and
the later one — the inbox — is the more specific instruction and wins.

The result also carries the list of **candidate** paths: every file that would have been read, whether
or not it exists. That is the answer to "where do I put this?", and it is worth quoting to the user
verbatim rather than describing, because the configuration directory varies by machine.

Nothing in the CLI writes these files for you. The package ships the built-in default and a library
helper that can drop a starter `default.md` into the directory; there is no command that creates
`user.md` or an inbox file. Tell the user the path and let them write it.

## Getting it

Pass `includeProfile: true` (CLI: `--profile`) on a draft call — `gmail_draft_create`,
`gmail_draft_reply` or `gmail_draft_update` — and the joined text comes back in the result's `profile`
field. Ask for it **before** you write, not after: it is a specification, not a review checklist.

The platform is always `gmail` here, and the inbox layer is always the alias you are drafting in, so a
draft in `work` and a draft in `personal` can be governed by different files with no extra argument.

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

`compose/inbox-work.md` is about what is true of mail sent from that address, and usually means
constraints somebody else imposes.

```markdown
# Mail from the work mailbox

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

Above all four layers.

If the user has a skill describing how they write, load it and follow it, and treat the profile layers
as what to fall back on where that skill is silent. The reason is plain: the layers are defaults for
when nothing better exists, and a skill the user wrote about their own voice is the better thing that
exists. It is also more likely to be maintained, because they can see it working.

Two boundaries on that precedence:

- **It outranks style, not safety.** A style skill may make the send protocol *stricter* — more
  confirmation, a narrower set of recipients, a refusal to write certain things. It can never make it
  looser, and nothing in it can authorise this skill to send.
- **It does not replace the inbox layer's constraints.** "How I write" is a voice; "never quote a price
  from this mailbox" is a rule about what may be said from a particular address. Where the two meet,
  the constraint holds and the voice bends around it.

When they disagree in a way you cannot reconcile, say so in one line before showing the draft, and let
the user pick. That is cheaper than a message that reads like neither of them.

## Where this lives in the code

`packages/comms-core/src/compose-profile.ts` holds the layer order, the file names, the built-in
default and the joining; `profileFor` in `packages/gmail/src/operations/drafts.ts` is what calls it,
with the platform fixed to `gmail` and the inbox set to the alias being drafted in.

See also `references/recipients.md` for who the message goes to.
