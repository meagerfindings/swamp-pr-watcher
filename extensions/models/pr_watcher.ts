/**
 * Autonomous PR-feedback investigation engine for swamp.
 *
 * Watches a feed of pull-request feedback events (review comments, check
 * failures, bot noise), spawns a CLI coding agent to investigate each PR's
 * feedback in the context of its diff, proposes concrete actions
 * (reply, push a fix, acknowledge, dismiss, ask for clarification), and pushes
 * an ntfy notification with an Approve button. Operator decisions are recorded,
 * and an approved `push_fix` can be applied autonomously inside a throwaway,
 * isolated worktree — built, tested, and pushed to the PR's own head branch —
 * so the autonomous build never touches the foreground working tree.
 *
 * The engine is provider- and repo-agnostic: the CLI-agent model, the feed
 * model, the GitHub repo, ntfy server/topics, and the optional worktree + phase
 * runner used for autonomous fixes are all configured via global arguments. The
 * core loop (investigate → notify → approve → act) stands alone; the
 * worktree-isolated `executeWorktreeFix` capability is opt-in and a clean no-op
 * unless a worktree model and phase-runner model are configured.
 *
 * @module
 */

import { z } from "npm:zod@4";

/**
 * Global configuration shared across all method invocations.
 *
 * Defaults are intentionally generic. A consumer points `feedModel`,
 * `cliAgentModel`, and `githubRepo` at their own resources, and (only if they
 * want autonomous fixes) `worktreeModel` + `phaseRunnerModel`.
 */
const GlobalArgsSchema = z.object({
  /** Name of the swamp model that produces `event-*` feedback records. */
  feedModel: z.string().default("pr-feed"),
  /** Local checkout the investigation agent reads (diff, files). */
  repoPath: z.string().default(`${Deno.env.get("HOME")}/git/repo`),
  /** GitHub `owner/name` the agent and `act` operate against. */
  githubRepo: z.string().default(""),
  /** Short human description of the repo injected into the agent prompt
   * (e.g. "Rails app", "Go service"). Optional. */
  repoDescription: z.string().default(""),
  /** Name of the @mgreten/cli-agent (or compatible) model to invoke. */
  cliAgentModel: z.string().default("cli-agent"),
  /** ntfy topic for outbound investigation / fix notifications. */
  ntfyTopic: z.string().default("pr-watch"),
  /** Base URL of the ntfy server. */
  ntfyBaseUrl: z.string().default("https://ntfy.sh"),
  /** Extra ntfy tag appended to every notification (e.g. a project label). */
  ntfyExtraTag: z.string().default(""),
  /** Provider passed to the CLI-agent model for investigations. */
  investigateProvider: z.string().default("claude"),
  /** Model id passed to the CLI-agent model for investigations. */
  investigateModelId: z.string().default("sonnet"),
  /** Wall-clock timeout (ms) for an investigation agent run. */
  investigateTimeoutMs: z.number().default(300_000),
  /** Path to the Todoist `td` CLI used to create approval tasks. */
  tdPath: z.string().default("td"),
  /** Todoist project for approval tasks. Empty disables Todoist task
   * creation entirely. */
  todoistProject: z.string().default(""),
  /** Label applied to approval tasks created in Todoist. */
  todoistLabel: z.string().default("approve-pr"),
  /** Optional worktree model (e.g. a git-worktree manager) used by
   * `executeWorktreeFix`. Empty disables autonomous worktree fixes. */
  worktreeModel: z.string().default(""),
  /** Optional phase-runner model (build/test/ship) used by
   * `executeWorktreeFix`. Empty disables autonomous worktree fixes. */
  phaseRunnerModel: z.string().default(""),
  /** ntfy topic the Approve button POSTs to; a poller drains it and calls
   * `approve` + `executeWorktreeFix`. Distinct from `ntfyTopic` so the poll
   * feed isn't polluted by outbound notifications. */
  approvalTopic: z.string().default("pr-approvals"),
  /** When true, `executeWorktreeFix` does NOT emit its own success/failure ntfy
   * notification — the fixRun artifact it returns carries `success`/`summary`/
   * `prUrl` so a caller (bridge) can deliver the notification itself (e.g. to
   * apply quiet-hours deferral the generic engine shouldn't bake in). The
   * fix still runs and is audited identically. */
  suppressFixNotifications: z.boolean().default(false),
});

/** A single action the investigation agent proposes for a piece of feedback. */
const ProposedActionSchema = z.object({
  type: z.enum([
    "reply_comment",
    "push_fix",
    "acknowledge",
    "dismiss",
    "request_clarification",
  ]),
  target: z.string().optional(),
  content: z.string(),
  confidence: z.number().min(0).max(1),
});

/** A completed investigation of one PR's outstanding feedback. */
const InvestigationSchema = z.object({
  investigationId: z.string(),
  prNumber: z.number(),
  prTitle: z.string(),
  prUrl: z.string(),
  eventIds: z.array(z.string()),
  summary: z.string(),
  proposedActions: z.array(ProposedActionSchema),
  context: z.object({
    filesReferenced: z.array(z.string()),
    diffSummary: z.string(),
  }),
  hasHumanFeedback: z.boolean(),
  investigatedAt: z.string(),
}).passthrough();

/** An operator decision recorded against an investigation. */
const ActionSchema = z.object({
  actionId: z.string(),
  investigationId: z.string(),
  prNumber: z.number(),
  eventIds: z.array(z.string()),
  decision: z.enum(["approved", "rejected", "modified", "deferred"]),
  userNote: z.string().optional(),
  executedAt: z.string().optional(),
  executionResult: z.string().optional(),
}).passthrough();

/** Audit record of one worktree-isolated autonomous fix attempt. */
const FixRunSchema = z.object({
  fixRunId: z.string(),
  investigationId: z.string(),
  prNumber: z.number(),
  headBranch: z.string(),
  worktreeId: z.string(),
  worktreePath: z.string(),
  // Phase outcomes — each is null if the phase was not reached.
  worktreeCreated: z.boolean(),
  checkoutOk: z.boolean().nullable(),
  buildOk: z.boolean().nullable(),
  testOk: z.boolean().nullable(),
  shipOk: z.boolean().nullable(),
  worktreeRemoved: z.boolean(),
  // Overall: true only if the fix was built, tested, and pushed.
  success: z.boolean(),
  summary: z.string(),
  prUrl: z.string().optional(),
  startedAt: z.string(),
  finishedAt: z.string().optional(),
}).passthrough();

/** Result of a shelled subprocess invocation. */
type CmdResult = {
  stdout: string;
  stderr: string;
  code: number;
  success: boolean;
};

/** Run a `swamp` subcommand scoped to a specific repo directory. */
async function runSwampCmd(
  args: string[],
  repoDir: string,
): Promise<CmdResult> {
  const command = new Deno.Command("swamp", {
    args: [...args, "--repo-dir", repoDir],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    code: output.code,
    success: output.success,
  };
}

/**
 * Resolve the swamp repo directory that hosts this model's sibling models.
 * Honors `SWAMP_REPO_DIR`; otherwise falls back to the current directory.
 */
export function resolveRepoDir(): string {
  return Deno.env.get("SWAMP_REPO_DIR") ?? Deno.cwd();
}

/**
 * Make a string safe to use as an HTTP header value. `fetch()` requires header
 * values to be ByteStrings (code points ≤ 255); any emoji or wider Unicode in a
 * dynamic value (e.g. a PR title) otherwise throws "not a valid ByteString" and
 * silently kills the whole notification. Characters outside Latin-1 are dropped.
 */
export function asciiHeader(value: string): string {
  // deno-lint-ignore no-control-regex
  return value.replace(/[^\x00-\xFF]/g, "").replace(/[\r\n]/g, " ").trim();
}

/**
 * Invoke the CLI-agent model (`invoke` or `invokeAndParse`) and normalize its
 * envelope into `{ success, output, error }`.
 */
async function invokeCliAgent(
  cliAgentModel: string,
  repoDir: string,
  opts: {
    prompt: string;
    provider: string;
    model: string;
    cwd: string;
    tags: Record<string, string>;
    wallTimeoutMs: number;
    parse: boolean;
  },
): Promise<{
  success: boolean;
  output: Record<string, unknown> | null;
  error?: string;
}> {
  const method = opts.parse ? "invokeAndParse" : "invoke";

  const inputFile = await Deno.makeTempFile({ suffix: ".json" });
  const inputs: Record<string, unknown> = {
    prompt: opts.prompt,
    provider: opts.provider,
    model: opts.model,
    cwd: opts.cwd,
    tags: opts.tags,
    wallTimeoutMs: opts.wallTimeoutMs,
  };

  await Deno.writeTextFile(inputFile, JSON.stringify(inputs, null, 2));

  const result = await runSwampCmd(
    [
      "model",
      "method",
      "run",
      cliAgentModel,
      method,
      "--input-file",
      inputFile,
      "--json",
    ],
    repoDir,
  );

  try {
    await Deno.remove(inputFile);
  } catch { /* cleanup */ }

  if (!result.success) {
    const errDetail = result.stderr.slice(0, 500) ||
      result.stdout.slice(0, 500) || `exit code ${result.code}`;
    return {
      success: false,
      output: null,
      error: `CLI failed (exit ${result.code}): ${errDetail}`,
    };
  }

  try {
    const data = JSON.parse(result.stdout);

    if (data.error) {
      return {
        success: false,
        output: null,
        error: `swamp error: ${data.error}`,
      };
    }

    if (data.status === "failed") {
      const failReason = data.logFile
        ? `method failed, see ${data.logFile}`
        : "method failed";
      return { success: false, output: null, error: failReason };
    }

    const artifact = data.dataArtifacts?.[0]?.attributes;
    if (!artifact) {
      return {
        success: false,
        output: null,
        error: "No artifact in response",
      };
    }

    if (opts.parse && !artifact.parsedResponse) {
      return {
        success: false,
        output: artifact,
        error: `No parsed JSON in agent output (raw: ${
          String(artifact.rawOutput ?? "").slice(0, 200)
        })`,
      };
    }

    return {
      success: artifact.success !== false,
      output: opts.parse ? artifact.parsedResponse : artifact,
    };
  } catch (e) {
    return {
      success: false,
      output: null,
      error: `Parse error: ${(e as Error).message}; stdout: ${
        result.stdout.slice(0, 200)
      }`,
    };
  }
}

/**
 * Run a method on another swamp model by shelling the CLI (the same transport
 * `invokeCliAgent` uses). Returns the parsed top-level JSON envelope.
 */
async function runModelMethod(
  model: string,
  method: string,
  inputs: Record<string, unknown>,
  repoDir: string,
): Promise<
  { success: boolean; data: Record<string, unknown> | null; error?: string }
> {
  const inputFile = await Deno.makeTempFile({ suffix: ".json" });
  await Deno.writeTextFile(inputFile, JSON.stringify(inputs, null, 2));

  const result = await runSwampCmd(
    [
      "model",
      "method",
      "run",
      model,
      method,
      "--input-file",
      inputFile,
      "--json",
    ],
    repoDir,
  );

  try {
    await Deno.remove(inputFile);
  } catch { /* cleanup */ }

  if (!result.success) {
    const errDetail = result.stderr.slice(0, 500) ||
      result.stdout.slice(0, 500) || `exit code ${result.code}`;
    return {
      success: false,
      data: null,
      error: `${model} ${method} failed (exit ${result.code}): ${errDetail}`,
    };
  }

  try {
    const data = JSON.parse(result.stdout);
    if (data.error) {
      return { success: false, data, error: `swamp error: ${data.error}` };
    }
    const ok = data.status === "succeeded";
    return {
      success: ok,
      data,
      error: ok ? undefined : `status=${data.status ?? "unknown"}`,
    };
  } catch (e) {
    return {
      success: false,
      data: null,
      error: `Parse error: ${(e as Error).message}; stdout: ${
        result.stdout.slice(0, 200)
      }`,
    };
  }
}

/**
 * Run a git command in a specific checkout. Used to land the worktree on the
 * PR's existing head branch before the autonomous build runs.
 */
async function runGitIn(
  cwd: string,
  args: string[],
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const cmd = new Deno.Command("git", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const out = await cmd.output();
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

/** Result of a shelled `gh` invocation. */
type GhResult = {
  stdout: string;
  stderr: string;
  success: boolean;
};

/** Run a `gh` (GitHub CLI) command. */
async function runGh(args: string[]): Promise<GhResult> {
  const cmd = new Deno.Command("gh", {
    args,
    stdout: "piped",
    stderr: "piped",
  });
  const output = await cmd.output();
  return {
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
    success: output.success,
  };
}

/**
 * Locate the single `approved` action recorded for an investigation. Shared by
 * `act` and `executeWorktreeFix`. Returns null when none is approved.
 */
async function findApprovedAction(
  investigationId: string,
  context: MethodContext,
): Promise<z.infer<typeof ActionSchema> | null> {
  const allActions = await context.dataRepository.findAllForModel(
    context.modelType,
    context.modelId,
  );
  for (const data of allActions) {
    if (data.tags?.specName !== "action") continue;
    const content = await context.dataRepository.getContent(
      context.modelType,
      context.modelId,
      data.name,
    );
    if (!content) continue;
    try {
      const actionData = JSON.parse(new TextDecoder().decode(content));
      if (
        actionData.investigationId === investigationId &&
        actionData.decision === "approved"
      ) {
        return actionData;
      }
    } catch { /* skip */ }
  }
  return null;
}

/** A single feedback event surfaced by the feed model. */
export type FeedbackEvent = {
  eventId: string;
  prNumber: number;
  prTitle: string;
  prUrl: string;
  headBranch: string;
  type: string;
  author: string;
  authorType: string;
  body: string;
  filePath?: string;
  line?: number;
  diffHunk?: string;
  state?: string;
  checkName?: string;
  checkConclusion?: string;
  detectedAt: string;
};

/**
 * Load `event-*` feedback records from the feed model, optionally filtered to a
 * single PR and/or a set of event ids.
 */
async function loadFeedbackEvents(
  _context: MethodContext,
  feedModel: string,
  repoDir: string,
  prNumber?: number,
  eventIds?: string[],
): Promise<FeedbackEvent[]> {
  const result = await runSwampCmd(
    ["data", "list", feedModel, "--json"],
    repoDir,
  );

  if (!result.success) return [];

  try {
    const data = JSON.parse(result.stdout);
    const groups = data.groups ?? [];
    const items: Array<{ name: string }> = groups.flatMap(
      (g: { items: Array<{ name: string }> }) => g.items ?? [],
    );

    const events: FeedbackEvent[] = [];
    for (const item of items) {
      if (!item.name.startsWith("event-")) continue;

      const content = await runSwampCmd(
        ["data", "get", feedModel, item.name, "--json"],
        repoDir,
      );
      if (!content.success) continue;

      try {
        const parsed = JSON.parse(content.stdout);
        const attrs = parsed.content ?? parsed.attributes ?? parsed;

        if (prNumber !== undefined && attrs.prNumber !== prNumber) continue;
        if (
          eventIds && eventIds.length > 0 &&
          !eventIds.includes(attrs.eventId)
        ) continue;

        events.push(attrs as FeedbackEvent);
      } catch { /* skip */ }
    }

    return events;
  } catch {
    return [];
  }
}

/**
 * Build the investigation prompt handed to the CLI agent for one PR. The repo
 * identity and description are injected from global args so the prompt is not
 * coupled to any particular project.
 */
export function buildInvestigationPrompt(
  prNumber: number,
  prTitle: string,
  prUrl: string,
  headBranch: string,
  events: FeedbackEvent[],
  githubRepo: string,
  repoDescription: string,
): string {
  const feedbackSections = events.map((e) => {
    let section = `### ${
      e.authorType === "bot" ? "Bot" : "Human"
    }: ${e.author} (${e.type})`;
    if (e.filePath) section += `\nFile: ${e.filePath}:${e.line ?? ""}`;
    if (e.diffHunk) section += `\n\`\`\`diff\n${e.diffHunk}\n\`\`\``;
    if (e.state) section += `\nReview state: ${e.state}`;
    if (e.checkName) {
      section += `\nCheck: ${e.checkName} (${e.checkConclusion})`;
    }
    section += `\n\n${e.body}`;
    return section;
  }).join("\n\n---\n\n");

  const repoLine = githubRepo
    ? `Repository: ${githubRepo}${
      repoDescription ? ` (${repoDescription})` : ""
    }`
    : (repoDescription ? `Repository: ${repoDescription}` : "");

  return `You are reviewing feedback on PR #${prNumber}: "${prTitle}"
${repoLine}
Branch: ${headBranch}
PR URL: ${prUrl}

## Feedback to analyze

${feedbackSections}

## Your task

1. Read the PR diff: \`git diff origin/main...${headBranch}\`
2. Read any files referenced in the feedback
3. Understand the reviewer's concern in the context of the code change
4. For each piece of feedback, propose ONE action:
   - \`reply_comment\` — draft a response (explain, agree, push back)
   - \`push_fix\` — describe a code fix that addresses the feedback
   - \`acknowledge\` — simple acknowledgment (for approvals, FYIs)
   - \`dismiss\` — feedback is not actionable (bot noise, already addressed)
   - \`request_clarification\` — ask the reviewer to elaborate

Respond with ONLY this JSON (no markdown fencing, no explanation):
{
  "summary": "Brief summary of all feedback and your assessment",
  "proposedActions": [
    {
      "type": "reply_comment|push_fix|acknowledge|dismiss|request_clarification",
      "target": "optional: comment ID, file path, or check name this action targets",
      "content": "draft reply text, fix description, or acknowledgment",
      "confidence": 0.0 to 1.0
    }
  ],
  "context": {
    "filesReferenced": ["list", "of", "files", "you", "read"],
    "diffSummary": "One-line summary of what the PR changes"
  }
}`;
}

/** Runtime context handed to every method's `execute`. */
type MethodContext = {
  globalArgs: z.infer<typeof GlobalArgsSchema>;
  definition: { id: string; name: string };
  modelType: string;
  modelId: string;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
    error: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    instanceName: string,
    data: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  readResource?: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  dataRepository: {
    findAllForModel: (
      type: string,
      modelId: string,
    ) => Promise<
      Array<{
        name: string;
        tags?: Record<string, string>;
        content?: Uint8Array;
      }>
    >;
    getContent: (
      type: string,
      modelId: string,
      dataName: string,
    ) => Promise<Uint8Array | null>;
  };
};

/**
 * Per-PR investigation, shared by the single `investigate` method and the
 * `investigateBatch` fan-out. Returns the investigation object; the caller is
 * responsible for persisting it via writeResource. Throws on no-events or a
 * failing agent so callers can decide whether to abort (single) or skip
 * (batch).
 */
async function runInvestigation(
  prNumber: number,
  eventIds: string[] | undefined,
  context: MethodContext,
): Promise<Record<string, unknown>> {
  const {
    feedModel,
    repoPath,
    cliAgentModel,
    githubRepo,
    repoDescription,
    investigateProvider,
    investigateModelId,
    investigateTimeoutMs,
  } = context.globalArgs;

  const repoDir = resolveRepoDir();

  context.logger.info(
    "Loading feedback events for PR #{prNumber} from {feed}",
    { prNumber, feed: feedModel },
  );

  const events = await loadFeedbackEvents(
    context,
    feedModel,
    repoDir,
    prNumber,
    eventIds,
  );

  if (events.length === 0) {
    context.logger.warning(
      "No feedback events found for PR #{prNumber}",
      { prNumber },
    );
    throw new Error(`No feedback events found for PR #${prNumber}`);
  }

  const firstEvent = events[0];
  const hasHumanFeedback = events.some((e) => e.authorType === "human");

  context.logger.info(
    "Investigating {count} events on PR #{prNumber} ({human} human, {bot} bot)",
    {
      count: events.length,
      prNumber,
      human: events.filter((e) => e.authorType === "human").length,
      bot: events.filter((e) => e.authorType === "bot").length,
    },
  );

  const prompt = buildInvestigationPrompt(
    prNumber,
    firstEvent.prTitle,
    firstEvent.prUrl,
    firstEvent.headBranch,
    events,
    githubRepo,
    repoDescription,
  );

  const agentResult = await invokeCliAgent(
    cliAgentModel,
    repoDir,
    {
      prompt,
      provider: investigateProvider,
      model: investigateModelId,
      cwd: repoPath,
      tags: {
        phase: "pr-watch-investigate",
        prNumber: String(prNumber),
      },
      wallTimeoutMs: investigateTimeoutMs,
      parse: true,
    },
  );

  if (!agentResult.success || !agentResult.output) {
    throw new Error(
      `Investigation agent failed: ${agentResult.error ?? "unknown error"}`,
    );
  }

  const parsed = agentResult.output as {
    summary?: string;
    proposedActions?: Array<{
      type: string;
      target?: string;
      content: string;
      confidence: number;
    }>;
    context?: {
      filesReferenced?: string[];
      diffSummary?: string;
    };
  };

  const investigationId = `inv-${prNumber}-${Date.now()}`;

  const investigation = {
    investigationId,
    prNumber,
    prTitle: firstEvent.prTitle,
    prUrl: firstEvent.prUrl,
    eventIds: events.map((e) => e.eventId),
    summary: parsed.summary ?? "No summary provided",
    proposedActions: (parsed.proposedActions ?? []).map((a) => ({
      type: a.type,
      target: a.target,
      content: a.content,
      confidence: a.confidence ?? 0.5,
    })),
    context: {
      filesReferenced: parsed.context?.filesReferenced ?? [],
      diffSummary: parsed.context?.diffSummary ?? "",
    },
    hasHumanFeedback,
    investigatedAt: new Date().toISOString(),
  };

  context.logger.info(
    "Investigation complete for PR #{prNumber}: {actions} proposed actions",
    { prNumber, actions: investigation.proposedActions.length },
  );

  return investigation;
}

/**
 * The pr-watcher model: a configurable PR-feedback investigation and
 * autonomous-fix engine. See the module doc for the full lifecycle.
 */
export const model = {
  type: "@mgreten/pr-watcher",
  version: "2026.06.26.3",
  globalArguments: GlobalArgsSchema,
  resources: {
    investigation: {
      description:
        "cli-agent investigation result with proposed actions for PR feedback",
      schema: InvestigationSchema,
      lifetime: "14d" as const,
      garbageCollection: 50,
    },
    action: {
      description:
        "User decision record for an investigation (approved, rejected, modified)",
      schema: ActionSchema,
      lifetime: "14d" as const,
      garbageCollection: 50,
    },
    fixRun: {
      description:
        "Audit record of a worktree-isolated autonomous push_fix execution: " +
        "which phases ran, their outcomes, and whether the PR branch was updated.",
      schema: FixRunSchema,
      lifetime: "14d" as const,
      garbageCollection: 50,
    },
  },
  methods: {
    investigate: {
      description:
        "Investigate new feedback on a PR by spawning a coding agent via " +
        "cli-agent that reads the diff, comments, and file context, then " +
        "proposes actions.",
      arguments: z.object({
        prNumber: z.number().describe("PR number to investigate"),
        eventIds: z.array(z.string()).optional().describe(
          "Specific event IDs to investigate (defaults to all for the PR)",
        ),
      }),
      execute: async (
        args: { prNumber: number; eventIds?: string[] },
        context: MethodContext,
      ) => {
        const investigation = await runInvestigation(
          args.prNumber,
          args.eventIds,
          context,
        );

        const handle = await context.writeResource(
          "investigation",
          investigation.investigationId as string,
          investigation as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },

    investigateBatch: {
      description:
        "Investigate new feedback on multiple PRs in a single execution. " +
        "Acquires the per-model lock once and runs each PR's investigation " +
        "sequentially inside it, avoiding the lock contention that fails when " +
        "the caller loops `investigate` N times. PRs with no events or a " +
        "failing agent are skipped (logged), not fatal.",
      arguments: z.object({
        prNumbers: z.array(z.number()).min(1).describe(
          "PR numbers to investigate in this batch",
        ),
      }),
      execute: async (
        args: { prNumbers: number[] },
        context: MethodContext,
      ) => {
        const handles = [];
        const skipped: Array<{ prNumber: number; reason: string }> = [];

        context.logger.info(
          "Batch investigation of {count} PRs: {prs}",
          { count: args.prNumbers.length, prs: args.prNumbers.join(", ") },
        );

        for (const prNumber of args.prNumbers) {
          try {
            const investigation = await runInvestigation(
              prNumber,
              undefined,
              context,
            );
            const handle = await context.writeResource(
              "investigation",
              investigation.investigationId as string,
              investigation as unknown as Record<string, unknown>,
            );
            handles.push(handle);
          } catch (e) {
            // One PR failing must not abort the rest of the batch — the whole
            // point of batching is to drain a backlog in one lock acquisition.
            const reason = e instanceof Error ? e.message : String(e);
            skipped.push({ prNumber, reason });
            context.logger.warning(
              "Skipped PR #{prNumber} in batch: {reason}",
              { prNumber, reason },
            );
          }
        }

        context.logger.info(
          "Batch complete: {ok} investigated, {skipped} skipped",
          { ok: handles.length, skipped: skipped.length },
        );

        return { dataHandles: handles };
      },
    },

    notify: {
      description:
        "Send an ntfy notification summarizing an investigation with proposed " +
        "actions and an Approve action button. Optionally creates a Todoist " +
        "approval task when a Todoist project is configured.",
      arguments: z.object({
        investigationId: z.string().describe(
          "ID of the investigation to notify about",
        ),
      }),
      execute: async (
        args: { investigationId: string },
        context: MethodContext,
      ) => {
        const { ntfyTopic, approvalTopic, ntfyBaseUrl, ntfyExtraTag } =
          context.globalArgs;

        const investigation = await context.readResource?.(
          args.investigationId,
        ) as z.infer<typeof InvestigationSchema> | null;

        if (!investigation) {
          throw new Error(
            `Investigation ${args.investigationId} not found`,
          );
        }

        const actionSummary = investigation.proposedActions
          .map(
            (a: z.infer<typeof ProposedActionSchema>) =>
              `• ${a.type}: ${a.content.slice(0, 120)}`,
          )
          .join("\n");

        const hasPushFix = investigation.proposedActions.some(
          (a: z.infer<typeof ProposedActionSchema>) => a.type === "push_fix",
        );

        const title =
          `PR #${investigation.prNumber}: ${investigation.eventIds.length} feedback`;
        const message = [
          investigation.prTitle,
          "",
          investigation.summary,
          "",
          "Proposed:",
          actionSummary,
          "",
          hasPushFix
            ? "Tap Approve to build+test+push the fix to this PR's branch in a worktree."
            : "No push_fix — Approve just records the decision.",
        ].join("\n");

        const priority = investigation.hasHumanFeedback ? 4 : 2;
        const baseTag = investigation.hasHumanFeedback ? "eyes" : "robot";
        const tagList = ntfyExtraTag ? `${baseTag},${ntfyExtraTag}` : baseTag;

        const ntfyUrl = `${ntfyBaseUrl}/${ntfyTopic}`;

        // ntfy `http` action button: tapping Approve POSTs the investigationId
        // to the approvals topic. A poller drains that topic and runs approve +
        // executeWorktreeFix where the worktree/build toolchain lives. ntfy
        // caps actions at 3.
        //
        // The action LABEL must stay ASCII: it travels in the `Actions` HTTP
        // header, and fetch() rejects any header value with a code point > 255
        // ("not a valid ByteString"). An emoji in the label silently breaks
        // every notification. Emoji belong in the message body or as ntfy tag
        // NAMES (see `Tags`), never in a header value.
        const approveAction =
          `http, Approve, ${ntfyBaseUrl}/${approvalTopic}, method=POST, ` +
          `body=${args.investigationId}, clear=true`;
        const viewAction = `view, View PR, ${investigation.prUrl}, clear=true`;
        const actions = [approveAction, viewAction].join("; ");

        context.logger.info("Sending notification to {url}", { url: ntfyUrl });

        try {
          const response = await fetch(ntfyUrl, {
            method: "POST",
            headers: {
              "Title": asciiHeader(title),
              "Priority": String(priority),
              "Tags": asciiHeader(tagList),
              "Actions": asciiHeader(actions),
              "Click": investigation.prUrl,
            },
            body: message,
          });

          if (!response.ok) {
            const respBody = await response.text();
            throw new Error(
              `ntfy HTTP ${response.status}: ${respBody.slice(0, 200)}`,
            );
          }

          context.logger.info(
            "Notification sent for investigation {id} on PR #{prNumber}",
            {
              id: args.investigationId,
              prNumber: investigation.prNumber,
            },
          );
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          context.logger.error("Failed to send notification: {error}", {
            error: msg,
          });
          throw new Error(`Notification failed: ${msg}`);
        }

        // Optional Todoist approval task — only when a project is configured.
        const { tdPath, todoistProject, todoistLabel } = context.globalArgs;
        if (todoistProject) {
          const taskContent =
            `PR #${investigation.prNumber}: ${investigation.prTitle}`;
          const taskDescription = [
            investigation.summary,
            "",
            `Investigation: ${args.investigationId}`,
            `PR: ${investigation.prUrl}`,
            "",
            `Actions: ${investigation.proposedActions.length} proposed`,
          ].join("\n");

          try {
            const tdCmd = new Deno.Command(tdPath, {
              args: [
                "task",
                "add",
                "--project",
                todoistProject,
                "--labels",
                todoistLabel,
                "--description",
                taskDescription,
                "--priority",
                investigation.hasHumanFeedback ? "3" : "1",
                "--no-spinner",
                taskContent,
              ],
              stdout: "piped",
              stderr: "piped",
            });
            const tdOutput = await tdCmd.output();
            if (tdOutput.success) {
              context.logger.info(
                "Todoist task created for PR #{prNumber}",
                { prNumber: investigation.prNumber },
              );
            } else {
              const tdErr = new TextDecoder().decode(tdOutput.stderr);
              context.logger.warning(
                "Todoist task creation failed: {error}",
                { error: tdErr.slice(0, 200) },
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            context.logger.warning(
              "Todoist task creation failed: {error}",
              { error: msg },
            );
          }
        }

        return { dataHandles: [] };
      },
    },

    approve: {
      description:
        "Record a user decision (approve, reject, modify, defer) for an " +
        "investigation.",
      arguments: z.object({
        investigationId: z.string(),
        decision: z.enum(["approved", "rejected", "modified", "deferred"]),
        userNote: z.string().optional(),
      }),
      execute: async (
        args: {
          investigationId: string;
          decision: "approved" | "rejected" | "modified" | "deferred";
          userNote?: string;
        },
        context: MethodContext,
      ) => {
        const investigation = await context.readResource?.(
          args.investigationId,
        ) as z.infer<typeof InvestigationSchema> | null;

        if (!investigation) {
          throw new Error(
            `Investigation ${args.investigationId} not found`,
          );
        }

        const actionId = `action-${Date.now()}`;
        const action = {
          actionId,
          investigationId: args.investigationId,
          prNumber: investigation.prNumber,
          eventIds: investigation.eventIds,
          decision: args.decision,
          userNote: args.userNote,
        };

        context.logger.info(
          "Recorded {decision} for investigation {id} on PR #{prNumber}",
          {
            decision: args.decision,
            id: args.investigationId,
            prNumber: investigation.prNumber,
          },
        );

        const handle = await context.writeResource(
          "action",
          actionId,
          action as unknown as Record<string, unknown>,
        );

        return { dataHandles: [handle] };
      },
    },

    act: {
      description:
        "Execute approved non-write actions for an investigation (draft " +
        "review replies). `push_fix` is intentionally NOT executed here — use " +
        "executeWorktreeFix for autonomous fixes inside an isolated worktree.",
      arguments: z.object({
        investigationId: z.string(),
      }),
      execute: async (
        args: { investigationId: string },
        context: MethodContext,
      ) => {
        const { githubRepo } = context.globalArgs;

        const investigation = await context.readResource?.(
          args.investigationId,
        ) as z.infer<typeof InvestigationSchema> | null;
        if (!investigation) {
          throw new Error(
            `Investigation ${args.investigationId} not found`,
          );
        }

        const approvedAction = await findApprovedAction(
          args.investigationId,
          context,
        );

        if (!approvedAction) {
          throw new Error(
            `No approved action found for investigation ${args.investigationId}`,
          );
        }

        if (!githubRepo) {
          throw new Error(
            "githubRepo global argument is not set — cannot post review replies",
          );
        }

        const results: string[] = [];

        for (const proposed of investigation.proposedActions) {
          if (proposed.type === "dismiss") {
            results.push(`Dismissed: ${proposed.target ?? "N/A"}`);
            continue;
          }

          if (proposed.type === "acknowledge") {
            results.push(`Acknowledged: ${proposed.content.slice(0, 100)}`);
            continue;
          }

          if (
            proposed.type === "reply_comment" ||
            proposed.type === "request_clarification"
          ) {
            // Create a PENDING review (draft) — requires manual submission
            // via the GitHub UI before it becomes visible to others.
            const ghResult = await runGh([
              "api",
              `repos/${githubRepo}/pulls/${investigation.prNumber}/reviews`,
              "--method",
              "POST",
              "--field",
              `body=${proposed.content}`,
              "--field",
              "event=PENDING",
            ]);
            results.push(
              ghResult.success
                ? `Draft review created on PR #${investigation.prNumber} (pending your submission)`
                : `Draft review failed: ${ghResult.stderr.slice(0, 200)}`,
            );
            continue;
          }

          if (proposed.type === "push_fix") {
            // push_fix is the credible source of a working-tree-wipe race: a
            // confused autonomous agent with write access to the foreground
            // checkout could clobber uncommitted edits. `act` therefore only
            // records the proposed fix; autonomous application happens in
            // executeWorktreeFix, which fences the build inside a throwaway
            // worktree (the safety boundary).
            results.push(
              `Push_fix proposed for PR #${investigation.prNumber} but NOT executed here — run executeWorktreeFix (isolated worktree) to apply it. Proposed content recorded in action.`,
            );
            context.logger.warning(
              "push_fix proposed but not executed by `act` (use executeWorktreeFix)",
              {
                prNumber: investigation.prNumber,
                actionId: approvedAction.actionId,
              },
            );
          }
        }

        const updatedAction = {
          ...approvedAction,
          executedAt: new Date().toISOString(),
          executionResult: results.join("; "),
        };

        const handle = await context.writeResource(
          "action",
          approvedAction.actionId,
          updatedAction as unknown as Record<string, unknown>,
        );

        context.logger.info(
          "Executed {count} actions for PR #{prNumber}: {results}",
          {
            count: results.length,
            prNumber: investigation.prNumber,
            results: results.join("; "),
          },
        );

        return { dataHandles: [handle] };
      },
    },

    executeWorktreeFix: {
      description:
        "Autonomously apply an approved push_fix inside a throwaway worktree, " +
        "test it, and push it to the PR's OWN head branch (updating the " +
        "existing PR in place), then tear the worktree down. The worktree is " +
        "the safety boundary: the autonomous build runs against an isolated " +
        "sibling checkout, never the foreground tree. No-op (not fatal) unless " +
        "worktreeModel + phaseRunnerModel are configured AND the investigation " +
        "has an approved action AND a push_fix proposed action.",
      arguments: z.object({
        investigationId: z.string(),
      }),
      execute: async (
        args: { investigationId: string },
        context: MethodContext,
      ) => {
        const {
          feedModel,
          repoPath,
          worktreeModel,
          phaseRunnerModel,
          suppressFixNotifications,
        } = context.globalArgs;
        const repoDir = resolveRepoDir();

        // Capability gate: autonomous fixes require both helper models.
        if (!worktreeModel || !phaseRunnerModel) {
          context.logger.info(
            "executeWorktreeFix is not configured (worktreeModel/phaseRunnerModel unset); skipping",
          );
          return { dataHandles: [] };
        }

        const investigation = await context.readResource?.(
          args.investigationId,
        ) as z.infer<typeof InvestigationSchema> | null;
        if (!investigation) {
          throw new Error(`Investigation ${args.investigationId} not found`);
        }

        // Gate 1: must be operator-approved.
        const approved = await findApprovedAction(
          args.investigationId,
          context,
        );
        if (!approved) {
          throw new Error(
            `No approved action for investigation ${args.investigationId} — ` +
              `refusing autonomous worktree fix`,
          );
        }

        // Gate 2: must actually propose a push_fix. dismiss/acknowledge/
        // reply_comment are handled (safely) by `act`, never here.
        const pushFixes = investigation.proposedActions.filter(
          (a: z.infer<typeof ProposedActionSchema>) => a.type === "push_fix",
        );
        if (pushFixes.length === 0) {
          context.logger.info(
            "No push_fix proposed for PR #{prNumber}; nothing for executeWorktreeFix to do",
            { prNumber: investigation.prNumber },
          );
          return { dataHandles: [] };
        }

        // Recover the PR head branch — it lives on the feed events, not the
        // investigation. We push the fix onto THIS branch (updating the exact
        // PR the notification was for), never a new or upstack branch.
        const events = await loadFeedbackEvents(
          context,
          feedModel,
          repoDir,
          investigation.prNumber,
        );
        const headBranch = events.find((e) => e.headBranch)?.headBranch;
        if (!headBranch) {
          throw new Error(
            `Could not determine head branch for PR #${investigation.prNumber}`,
          );
        }

        const worktreeId = `pr-${investigation.prNumber}-fix`;
        // The worktree model creates worktrees as siblings of the repo:
        // {dirname(repoPath)}/{identifier}.
        const repoParent = repoPath.split("/").slice(0, -1).join("/");
        const worktreePath = `${repoParent}/${worktreeId}`;

        const fixRunId = `fix-${investigation.prNumber}-${Date.now()}`;
        const fixRun: z.infer<typeof FixRunSchema> = {
          fixRunId,
          investigationId: args.investigationId,
          prNumber: investigation.prNumber,
          headBranch,
          worktreeId,
          worktreePath,
          worktreeCreated: false,
          checkoutOk: null,
          buildOk: null,
          testOk: null,
          shipOk: null,
          worktreeRemoved: false,
          success: false,
          summary: "",
          startedAt: new Date().toISOString(),
        };

        // The fix instruction handed to the build phase. Multiple push_fixes
        // are concatenated; the build phase owns the commit.
        const fixInstruction = [
          `# Fix for PR #${investigation.prNumber}: ${investigation.prTitle}`,
          "",
          `You are on branch \`${headBranch}\`, the existing head branch of this PR.`,
          "Apply ONLY the fix(es) below. Do not refactor unrelated code.",
          "",
          ...pushFixes.map((f, i) =>
            `## Fix ${i + 1}${f.target ? ` (${f.target})` : ""}\n${f.content}`
          ),
        ].join("\n");

        // Record the fixRun and (only on success) tear the worktree down. On
        // FAILURE the worktree is KEPT — with the partial fix and the PR's
        // branch already checked out — so the operator can cd in and finish by
        // hand. The fixRun artifact records its path.
        const finalize = async (
          keepWorktree: boolean,
        ): Promise<{ dataHandles: [Record<string, unknown>] }> => {
          if (fixRun.worktreeCreated && !keepWorktree) {
            const rm = await runModelMethod(
              worktreeModel,
              "remove",
              { identifier: worktreeId },
              repoDir,
            );
            fixRun.worktreeRemoved = rm.success;
            if (!rm.success) {
              context.logger.warning(
                "Worktree {id} teardown failed (manual cleanup needed): {err}",
                { id: worktreeId, err: rm.error ?? "unknown" },
              );
            }
          }
          fixRun.finishedAt = new Date().toISOString();
          const handle = await context.writeResource(
            "fixRun",
            fixRunId,
            fixRun as unknown as Record<string, unknown>,
          );
          return { dataHandles: [handle] };
        };

        // Push a failure alert back to the ntfy topic so it reaches the phone
        // and is waiting when the laptop terminal is reopened. Best effort — a
        // notify failure must not mask the underlying fix failure.
        const notifyFixFailure = async (
          phase: string,
          resumable: boolean,
        ): Promise<void> => {
          const { ntfyTopic, ntfyBaseUrl, ntfyExtraTag } = context.globalArgs;
          const lines = [
            investigation.prTitle,
            "",
            fixRun.summary,
          ];
          if (resumable) {
            lines.push(
              "",
              `Worktree kept: ${worktreePath}`,
              `Resume: cd ${worktreePath} and finish the fix by hand`,
              `Then push to update PR #${investigation.prNumber}`,
            );
          } else {
            lines.push("", "Worktree cleaned up (nothing to resume).");
          }
          try {
            await fetch(`${ntfyBaseUrl}/${ntfyTopic}`, {
              method: "POST",
              headers: {
                // Title stays ASCII (HTTP header = ByteString). The `x` tag
                // below renders the ❌ emoji in the ntfy client.
                "Title": asciiHeader(
                  `PR #${investigation.prNumber} fix FAILED at ${phase}`,
                ),
                "Priority": "4",
                "Tags": ntfyExtraTag ? `x,${ntfyExtraTag}` : "x",
                "Click": investigation.prUrl,
              },
              body: lines.join("\n"),
            });
          } catch (err) {
            context.logger.warning(
              "Failure notification could not be sent: {err}",
              { err: err instanceof Error ? err.message : String(err) },
            );
          }
        };

        const fail = async (
          phase: string,
          detail: string,
        ): Promise<{ dataHandles: [Record<string, unknown>] }> => {
          fixRun.summary = `${phase} failed: ${detail}`.slice(0, 500);
          context.logger.error(
            "executeWorktreeFix PR #{prNumber} {phase}: {detail}",
            { prNumber: investigation.prNumber, phase, detail },
          );
          // Keep the worktree only once it holds resumable work (build/test/
          // ship). The cheap early failures (worktree-add, fetch, checkout)
          // have nothing to salvage, so those still clean up.
          const resumable = ["build", "test", "ship"].includes(phase);
          if (!suppressFixNotifications) {
            await notifyFixFailure(phase, resumable);
          }
          return await finalize(resumable);
        };

        // Push a success alert to the same ntfy topic so a tap from the phone
        // always reports its outcome (symmetry with notifyFixFailure) —
        // silence would be ambiguous.
        const notifyFixSuccess = async (): Promise<void> => {
          const { ntfyTopic, ntfyBaseUrl, ntfyExtraTag } = context.globalArgs;
          try {
            await fetch(`${ntfyBaseUrl}/${ntfyTopic}`, {
              method: "POST",
              headers: {
                // Title stays ASCII (HTTP header = ByteString). The
                // white_check_mark tag renders the ✅ emoji in the ntfy client.
                "Title": `PR #${investigation.prNumber} fix pushed`,
                "Priority": "3",
                "Tags": ntfyExtraTag
                  ? `white_check_mark,${ntfyExtraTag}`
                  : "white_check_mark",
                "Click": investigation.prUrl,
              },
              body: [
                investigation.prTitle,
                "",
                `Built, tested, and pushed to ${headBranch}.`,
              ].join("\n"),
            });
          } catch (err) {
            context.logger.warning(
              "Success notification could not be sent: {err}",
              { err: err instanceof Error ? err.message : String(err) },
            );
          }
        };

        context.logger.info(
          "executeWorktreeFix PR #{prNumber}: {n} push_fix on branch {branch}",
          {
            prNumber: investigation.prNumber,
            n: pushFixes.length,
            branch: headBranch,
          },
        );

        // 1) Create the isolated worktree (the safety boundary).
        const add = await runModelMethod(
          worktreeModel,
          "add",
          { identifier: worktreeId },
          repoDir,
        );
        if (!add.success) {
          return await fail("worktree-add", add.error ?? "unknown");
        }
        fixRun.worktreeCreated = true;

        // Verify the checkout actually materialized where we expect before we
        // point an autonomous build at it.
        try {
          const st = await Deno.stat(worktreePath);
          if (!st.isDirectory) throw new Error("not a directory");
        } catch {
          return await fail(
            "worktree-verify",
            `expected worktree at ${worktreePath} but it is absent`,
          );
        }

        // 2) Land on the PR's existing head branch inside the worktree.
        const fetchResult = await runGitIn(worktreePath, [
          "fetch",
          "origin",
          headBranch,
        ]);
        if (!fetchResult.success) {
          fixRun.checkoutOk = false;
          return await fail("git-fetch", fetchResult.stderr.slice(0, 300));
        }
        const checkout = await runGitIn(worktreePath, [
          "checkout",
          headBranch,
        ]);
        if (!checkout.success) {
          fixRun.checkoutOk = false;
          return await fail("git-checkout", checkout.stderr.slice(0, 300));
        }
        // Hard-align to the remote tip so the fix builds on the PR's actual
        // current state, not a stale cached worktree branch.
        await runGitIn(worktreePath, [
          "reset",
          "--hard",
          `origin/${headBranch}`,
        ]);
        fixRun.checkoutOk = true;

        // 3) Build the fix (build phase owns the commit), fenced to the worktree.
        const build = await runModelMethod(
          phaseRunnerModel,
          "build",
          { prompt: fixInstruction, repoPath: worktreePath },
          repoDir,
        );
        fixRun.buildOk = build.success;
        if (!build.success) {
          return await fail("build", build.error ?? "unknown");
        }

        // 4) Test in the worktree. A test failure blocks the push.
        const test = await runModelMethod(
          phaseRunnerModel,
          "test",
          { repoPath: worktreePath, baseBranch: `origin/${headBranch}` },
          repoDir,
        );
        fixRun.testOk = test.success;
        if (!test.success) {
          return await fail("test", test.error ?? "tests failed");
        }

        // 5) Ship: submit from the worktree updates the PR branch in place.
        const ship = await runModelMethod(
          phaseRunnerModel,
          "ship",
          { branchName: headBranch, repoPath: worktreePath },
          repoDir,
        );
        fixRun.shipOk = ship.success;
        if (!ship.success) {
          return await fail("ship", ship.error ?? "submit failed");
        }

        // Pull the PR url out of the ship artifact if present.
        const shipArtifact = (ship.data?.dataArtifacts as
          | Array<{ attributes?: { prUrl?: string } }>
          | undefined)?.[0]?.attributes;
        if (shipArtifact?.prUrl) fixRun.prUrl = shipArtifact.prUrl;

        fixRun.success = true;
        fixRun.summary =
          `Fix built, tested, and pushed to ${headBranch} (PR #${investigation.prNumber})`;
        context.logger.info(
          "executeWorktreeFix PR #{prNumber} SUCCEEDED — pushed to {branch}",
          { prNumber: investigation.prNumber, branch: headBranch },
        );

        if (!suppressFixNotifications) await notifyFixSuccess();
        return await finalize(false);
      },
    },
  },
};
