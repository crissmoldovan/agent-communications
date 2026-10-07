---
name: review-pr
description: Use when a pull request to this repository needs checking, reviewing or merging — "check Omar's PR", "is #52 fine?", "review and merge it" — in order, on a worktree of its own, without disturbing another session's checkout
---

# Reviewing and merging a pull request

A pull request is merged in one order, and each step ends in something you can show: what it carries, what its code
does on this machine, what the riskiest part says, and the commit that went into `main`. The order exists because
the expensive mistakes here are quiet ones — a contributor's code run before anyone read it, a "passes locally" taken
on trust, a merge of a head that moved after it was checked, or another session's checkout changed under it.

**Only the maintainer merges.** Rulesets on the repository refuse a merge, a push to `main` or a `v*` tag from anyone
without bypass, so the merge is theirs and is made on their word — never inferred from a finished review.

## Procedure

1. **Read the pull request and what it carries.** `gh pr view <n>` for its description, commits and files;
   `gh pr checks <n>` for the requirements check and the Blocks review. Hold it to
   [What every pull request carries](../../../CONTRIBUTING.md#what-every-pull-request-carries): what changes and how, a
   proposed version `X.Y.Z-<branch-slug>` one semver step on from `main`, tests, docs, a changelog entry, provenance,
   no real data.
   **If any of it is missing, the submitter completes it.** Draft the comment that says what is missing, show it to the
   maintainer, and post it only on their yes. Do not fill it in for them, and do not carry on to a merge.
   **Complete when:** every item is present, or the request for what is not has been posted with the maintainer's yes.

2. **Check it out on a worktree of its own.** Another session may be working in the shared checkout and in its own
   worktrees; a review touches neither.
   `git fetch origin pull/<n>/head:review/pr-<n>` and `git worktree add ../.agentcomms-wt/pr-<n> review/pr-<n>`.
   **Complete when:** the worktree is at the pull request's head, and its base is the current `main`.

3. **Read before you run.** A contributor's tests are code that runs on this machine. Before `pnpm install` or
   `pnpm verify`, look at the diff for changes to `package.json`, the lockfile, `scripts/`, `.githooks/` or
   `.github/`; for `child_process`, `spawn` or a host other than the provider's own documentation, `localhost` and
   `example.*`/`*.test`; for reads of the environment; and for anything shaped like a real token, address or account
   id. Anything there is read in full and raised before going on.
   **Complete when:** each of those searches has been run and its result is known.

4. **Verify it here.** `pnpm install --frozen-lockfile && pnpm verify` in the worktree, and record the per-package
   pass and fail counts. "Passes locally" in the description is the contributor's claim; this is the evidence.
   **Complete when:** `pnpm verify` exits 0 on the head being reviewed, and the counts are written down.

5. **Read the riskiest part first.** The send gate (`send.execute`, `executeSend`), the Slack guard and its permits
   (`packages/slack/src/api/guard.ts`, `methods.ts`), path jails, untrusted-content handling, and anything that holds a
   credential. Check every Blocks finding against the code before agreeing with it or dismissing it: a finding is a
   claim, and so is its fix.
   **Complete when:** each finding is confirmed with its path and line or refuted with the evidence, and every
   confirmed one is fixed on the branch, with a test that failed before the fix.

6. **Say go or no-go, and stop.** Give the maintainer the verdict with what it rests on: the verify counts, the
   findings and their state, what is still missing. Request changes, as a comment the maintainer has approved, when
   anything is outstanding. After every new push, steps 2 to 5 run again on the new head.
   **Complete when:** the maintainer has said to merge, about this head.

7. **Merge on GitHub, pinned to the commit you verified.** Never in a local checkout another session uses, and never
   by pushing `main` from here.
   ```bash
   gh pr view <n> --json headRefOid,mergeable          # the head is still the one verified, and main has not moved
   gh pr review <n> --approve --body "<what was checked>"
   gh pr merge <n> --rebase --admin --match-head-commit <verified sha>
   ```
   Rebase-and-merge keeps each commit's author and message. `--admin` is the maintainer's bypass: without it the
   ruleset refuses the merge ("the base branch policy prohibits the merge"), which is the rule doing its job.
   **Complete when:** the pull request is merged and names the merge commit.

8. **Prove what landed.** `git fetch origin` and `git diff --quiet <verified sha> origin/main` — when `main` had not
   moved, the tree on `main` is the tree that was verified. Check every commit kept its author, that the shared
   checkout and the other session's worktrees are as they were, and remove the review worktree and branch.
   **Complete when:** the diff is empty (or, if `main` had moved, `pnpm verify` has passed on `origin/main`), and the
   review worktree is gone.

## Pitfalls

- **Running a contributor's tests before reading them.** Step 3 is the only thing between their code and this machine.
- **Reviewing a head that has moved.** Contributors push fixes during a review; the Blocks result, the verify and the
  merge must all name the same commit.
- **Filling in what the submitter left out.** It hides who knew what, and the next pull request arrives the same way.
- **Merging because the review finished.** The merge is the maintainer's decision, about a head, said in words.
- **Pulling or merging in the shared checkout.** Another session's work lives there; `origin/main` is changed on
  GitHub, and each session catches up when it chooses.
