# @mgreten/pr-watcher

A configurable, autonomous pull-request feedback engine for
[swamp](https://swamp.club). It watches a feed of PR feedback events (review
comments, check failures, bot noise), spawns a CLI coding agent to investigate
each PR's feedback in the context of its diff, proposes concrete actions
(reply, push a fix, acknowledge, dismiss, ask for clarification), and sends an
ntfy notification with an **Approve** button. Operator decisions are recorded,
and an approved `push_fix` can optionally be applied autonomously inside a
throwaway, isolated worktree — built, tested, and pushed straight to the PR's
own head branch.

The engine is provider- and repo-agnostic. The CLI-agent model, the feed model,
the GitHub repo, the ntfy server/topics, and the optional worktree + phase
runner used for autonomous fixes are all configured via global arguments. The
core loop (investigate → notify → approve → act) works on its own; the
worktree-isolated `executeWorktreeFix` capability is opt-in and a clean no-op
unless a worktree model and a phase-runner model are configured.

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

Record an approval and (optionally) apply the fix in an isolated worktree:

```bash
swamp model method run pr-watcher approve \
  --input investigationId=inv-1234-1700000000000 \
  --input decision=approved --json

swamp model method run pr-watcher executeWorktreeFix \
  --input investigationId=inv-1234-1700000000000 --json
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

Record an operator decision for an investigation.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation being decided |
| `decision` | enum | yes | `approved` \| `rejected` \| `modified` \| `deferred` |
| `userNote` | string | no | Optional note |

## Method: act

Execute approved non-write actions (draft GitHub review replies via `gh`).
`push_fix` is intentionally NOT executed here — use `executeWorktreeFix`.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation whose approved actions to act on |

## Method: executeWorktreeFix

Apply an approved `push_fix` autonomously inside a throwaway worktree, test it,
and push to the PR's own head branch, then tear the worktree down. A no-op
(not fatal) unless `worktreeModel` + `phaseRunnerModel` are configured AND the
investigation has an approved action AND a `push_fix`. On a build/test/ship
failure the worktree is kept (with the partial fix checked out) for manual
resume; cheap early failures clean up.

| Argument | Type | Required | Purpose |
|----------|------|----------|---------|
| `investigationId` | string | yes | Investigation whose `push_fix` to apply |

## How It Works

`investigate` loads `event-*` records from the feed model, builds a prompt with
the feedback grouped by author and diff context, and calls the CLI-agent model's
`invokeAndParse` to get back structured proposed actions. The result is stored as
an `investigation` resource (14-day lifetime).

`notify` reads an investigation and POSTs to ntfy with an Approve button whose
`http` action POSTs the investigation id to the `approvalTopic`. A poller of your
own (launchd, cron, systemd, etc.) drains that topic and calls `approve` then
`executeWorktreeFix`.

The worktree-fix path is the safety boundary: the autonomous build runs against
an isolated sibling checkout created by `worktreeModel`, never the foreground
working tree. The build/test/ship phases are delegated to `phaseRunnerModel`.

**Prerequisites:** a feed model emitting `event-*` records, an
`@mgreten/cli-agent`-compatible model, the `gh` CLI authenticated for review
replies, and (for autonomous fixes only) worktree + phase-runner models. Sibling
model invocations are scoped via the `SWAMP_REPO_DIR` environment variable, or
the current working directory if unset.

## License

MIT — see LICENSE for details.
