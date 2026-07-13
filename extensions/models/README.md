# @mgreten/pr-watcher

A configurable, autonomous pull-request feedback engine for
[swamp](https://swamp.club). It watches a feed of PR feedback events (review
comments, check failures, bot noise), spawns a CLI coding agent to investigate
each PR's feedback in the context of its diff, proposes concrete actions
(reply, push a fix, acknowledge, dismiss, ask for clarification), and sends an
ntfy notification with an **Approve** button. Operator decisions are recorded
via `approve`.

A proposed `push_fix` follows a **build-then-approve** flow: `buildFixCandidate`
builds and tests the fix inside a throwaway, isolated worktree *before* any
approval exists, captures the result as a portable artifact (a git bundle plus
the full diff), and sends a deblinded approval notification showing the actual
diff with an Approve button hash-bound to it. `approve` requires that hash to
match (and not be expired). `pushApprovedFix` re-verifies the hash and that the
PR's head branch hasn't moved since build, then applies the bundle and ships.

The engine is provider- and repo-agnostic. The CLI-agent model, the feed model,
the GitHub repo, the ntfy server/topics, and the optional worktree + phase
runner used for autonomous fixes are all configured via global arguments. The
core loop (investigate → notify → approve → act) works on its own; the
worktree-isolated `buildFixCandidate`/`pushApprovedFix` capability is opt-in
and a clean no-op unless a worktree model and a phase-runner model are
configured. The older single-shot `executeWorktreeFix` (approve-before-build)
is retired and fails closed — it approved a summary before the diff existed.

## Installation

```bash
swamp extension pull @mgreten/pr-watcher
```

## Setup

Create an instance and point it at your feed model, CLI-agent model, and GitHub
repo:

```bash
swamp model create pr-watcher @mgreten/pr-watcher \
  --global-arg feedModel=pr-feed \
  --global-arg cliAgentModel=cli-agent \
  --global-arg githubRepo=octocat/hello-world \
  --global-arg ntfyTopic=pr-watch \
  --global-arg ntfyBaseUrl=https://ntfy.sh
```

This extension expects an [`@mgreten/cli-agent`](https://github.com/meagerfindings/swamp-cli-agent)
(or compatible) model that exposes `invoke` / `invokeAndParse`, and a feed model
that produces `event-*` data records (one per feedback item).

## Usage

Investigate a backlog of PRs in a single lock acquisition, then notify on each:

```bash
swamp model method run pr-watcher investigateBatch \
  --input "prNumbers:json=[1234,1235]" --json

swamp model method run pr-watcher notify \
  --input investigationId=inv-1234-1700000000000 --json
```

For a `push_fix` investigation, build+test first — this sends the real,
diff-bearing approval notification:

```bash
swamp model method run pr-watcher buildFixCandidate \
  --input investigationId=inv-1234-1700000000000 --json
```

Then approve with the `approvalHash` from that notification (or from reading
the `fixCandidate` resource) and push:

```bash
swamp model method run pr-watcher approve \
  --input investigationId=inv-1234-1700000000000 \
  --input decision=approved \
  --input approvalHash=<hash from the fixCandidate> --json

swamp model method run pr-watcher pushApprovedFix \
  --input investigationId=inv-1234-1700000000000 --json
```

For non-`push_fix` decisions (reply/acknowledge/dismiss/clarify), `approve`
doesn't require a hash:

```bash
swamp model method run pr-watcher approve \
  --input investigationId=inv-1234-1700000000000 \
  --input decision=approved --json
```

## Global Arguments

| Argument | Type | Default | Purpose |
|----------|------|---------|---------|
| `feedModel` | string | `pr-feed` | Model that produces `event-*` feedback records |
| `repoPath` | string | `$HOME/git/repo` | Local checkout the agent reads |
| `githubRepo` | string | `""` | GitHub `owner/name` for `act` review replies |
| `repoDescription` | string | `""` | Short repo description injected into the prompt |
| `cliAgentModel` | string | `cli-agent` | CLI-agent model to invoke for investigations |
| `ntfyTopic` | string | `pr-watch` | ntfy topic for outbound notifications |
| `ntfyBaseUrl` | string | `https://ntfy.sh` | ntfy server base URL |
| `ntfyExtraTag` | string | `""` | Extra ntfy tag appended to every notification |
| `investigateProvider` | string | `claude` | Provider passed to cli-agent |
| `investigateModelId` | string | `sonnet` | Model id passed to cli-agent |
| `investigateTimeoutMs` | number | `300000` | Wall-clock timeout for an investigation |
| `tdPath` | string | `td` | Path to the Todoist `td` CLI |
| `todoistProject` | string | `""` | Todoist project for approval tasks (empty disables) |
| `todoistLabel` | string | `approve-pr` | Label applied to Todoist approval tasks |
| `worktreeModel` | string | `""` | Worktree manager model (empty disables autonomous fixes) |
| `phaseRunnerModel` | string | `""` | Build/test/ship model (empty disables autonomous fixes) |
| `approvalTopic` | string | `pr-approvals` | ntfy topic the Approve button POSTs to |

## Method: investigate

Investigate one PR's outstanding feedback.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `prNumber` | number | yes | PR number to investigate |
| `eventIds` | string[] | no | Specific event IDs (defaults to all for the PR) |

## Method: investigateBatch

Investigate several PRs in a single execution, acquiring the per-model lock once.
PRs with no events or a failing agent are skipped (logged), not fatal.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `prNumbers` | number[] | yes | PR numbers to investigate in this batch |

## Method: notify

Send an ntfy notification for an investigation with an Approve action button.
Creates a Todoist approval task when `todoistProject` is set.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation to notify about |

## Method: approve

Record an operator decision for an investigation. When the investigation has a
built `fixCandidate` (a `push_fix` that reached `buildFixCandidate`), approving
it REQUIRES `approvalHash` to match the candidate's current hash exactly, and
the candidate must not be expired — this is the hash-bound, deblinded approval
gate. Non-candidate investigations (reply/ack/dismiss/clarify) don't require a
hash.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation being decided |
| `decision` | enum | yes | `approved` \| `rejected` \| `modified` \| `deferred` |
| `approvalHash` | string | conditionally | Required (and must match) when approving a built `push_fix` |
| `userNote` | string | no | Optional note |

## Method: act

Execute approved non-write actions (draft GitHub review replies via `gh`).
`push_fix` is intentionally NOT executed here — use `buildFixCandidate` +
`pushApprovedFix`.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation whose approved actions to act on |

## Method: buildFixCandidate

Build and test a proposed `push_fix` inside a throwaway worktree — **no
push**. NOT gated on an approved action (build happens before approval, by
design). Captures the built commit as a portable `fixCandidate` artifact: a
git bundle, the full diff, and a sha256 `approvalHash` binding the diff to its
commit, base, repo, branch, and a 24h expiry. Tears the worktree down on
success (the bundle is the portable artifact) or keeps it (for manual resume)
on a build/test failure. Sends the deblinded approval notification — the one
that actually authorizes a push — showing the real diff. A no-op (not fatal)
unless `worktreeModel` + `phaseRunnerModel` are configured AND the
investigation has a `push_fix`.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation whose `push_fix` to build |

## Method: pushApprovedFix

Push a hash-approved `fixCandidate` to the PR's head branch. Gated on: an
approved action whose recorded hash matches the candidate's *current*
`approvalHash` (re-verified here, not just trusted from `approve` time), the
candidate not expired, and the PR's remote head branch being unchanged since
build (refuses — "PR head moved since build, rebuild needed" — if it moved).
Applies the candidate's bundle in a **fresh** worktree, verifies the landed
commit sha and a recomputed hash both match exactly, then ships via
`phaseRunnerModel`. On failure the worktree is kept for manual resume where
applicable; cheap early failures clean up.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation whose approved fix to push |

## Method: executeWorktreeFix (retired)

Fails closed with an error pointing at `buildFixCandidate` +
`pushApprovedFix`. Kept only so an un-updated caller fails loudly instead of
silently pushing an unreviewed diff — the old single-shot flow approved a
120-char summary before the fix was ever built, so the approval never covered
the actual diff.

## How It Works

`investigate` loads `event-*` records from the feed model, builds a prompt with
the feedback grouped by author and diff context, and calls the CLI-agent model's
`invokeAndParse` to get back structured proposed actions. The result is stored as
an `investigation` resource (14-day lifetime).

`notify` reads an investigation and POSTs to ntfy with an Approve button whose
`http` action POSTs the investigation id to the `approvalTopic` — for a
`push_fix` investigation this is only a pre-build summary (no diff exists yet
to hash-bind). A poller of your own (launchd, cron, systemd, etc.) drains that
topic and calls `approve` then, for `push_fix`, `buildFixCandidate`.

The worktree-fix path is the safety boundary: the autonomous build and push
each run against a fresh, isolated sibling checkout created by
`worktreeModel`, never the foreground working tree. The build/test/ship
phases are delegated to `phaseRunnerModel`. Between build and push, the
candidate lives as a git bundle on disk — no worktree stays alive across the
approval wait.

**Prerequisites:** a feed model emitting `event-*` records, an
`@mgreten/cli-agent`-compatible model, the `gh` CLI authenticated for review
replies, and (for autonomous fixes only) worktree + phase-runner models. Sibling
model invocations are scoped via the `SWAMP_REPO_DIR` environment variable, or
the current working directory if unset.

## License

MIT — see LICENSE for details.
