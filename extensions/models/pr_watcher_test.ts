/**
 * Unit tests for the pure, repo-agnostic helpers in `pr_watcher.ts`.
 *
 * These cover the generalization seams that make the engine project-neutral:
 * the investigation prompt's repo-identity line (all combinations of
 * githubRepo/repoDescription), the per-event feedback formatting (human vs bot,
 * diff hunks, check results), and the SWAMP_REPO_DIR resolution fallback.
 */

import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  asciiHeader,
  buildInvestigationPrompt,
  type FeedbackEvent,
  resolveRepoDir,
} from "./pr_watcher.ts";

// --- asciiHeader ------------------------------------------------------------

Deno.test("asciiHeader strips emoji so the value is a valid ByteString", () => {
  const cleaned = asciiHeader("✅ Approve");
  assertEquals(cleaned, "Approve");
  // Every remaining code point must fit in a ByteString (<= 0xFF).
  for (const ch of cleaned) assert(ch.codePointAt(0)! <= 0xff);
});

Deno.test("asciiHeader keeps Latin-1 text and collapses newlines", () => {
  assertEquals(asciiHeader("PR #42 fix FAILED at build"), "PR #42 fix FAILED at build");
  assertEquals(asciiHeader("line1\nline2"), "line1 line2");
});

Deno.test("asciiHeader output never throws when used as a fetch header", () => {
  const dirty = "🚀 PR — café build ❌";
  const cleaned = asciiHeader(dirty);
  // Construct a Headers object — this is exactly what fetch() validates.
  const h = new Headers();
  h.set("Title", cleaned); // must not throw
  assertEquals(h.get("Title"), cleaned);
});

// --- Fixtures ---------------------------------------------------------------

const humanReviewEvent: FeedbackEvent = {
  eventId: "event-1",
  prNumber: 42,
  prTitle: "Add widget",
  prUrl: "https://github.com/octocat/hello-world/pull/42",
  headBranch: "feature/widget",
  type: "review_comment",
  author: "alice",
  authorType: "human",
  body: "This nil check looks wrong.",
  filePath: "lib/widget.rb",
  line: 17,
  diffHunk: "- foo\n+ bar",
  detectedAt: "2026-06-26T00:00:00Z",
};

const botCheckEvent: FeedbackEvent = {
  eventId: "event-2",
  prNumber: 42,
  prTitle: "Add widget",
  prUrl: "https://github.com/octocat/hello-world/pull/42",
  headBranch: "feature/widget",
  type: "check_run",
  author: "ci-bot",
  authorType: "bot",
  body: "Build failed.",
  checkName: "rspec",
  checkConclusion: "failure",
  state: "completed",
  detectedAt: "2026-06-26T00:00:00Z",
};

// --- resolveRepoDir ---------------------------------------------------------

Deno.test("resolveRepoDir honors SWAMP_REPO_DIR when set", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.set("SWAMP_REPO_DIR", "/tmp/some-repo");
    assertEquals(resolveRepoDir(), "/tmp/some-repo");
  } finally {
    if (original === undefined) Deno.env.delete("SWAMP_REPO_DIR");
    else Deno.env.set("SWAMP_REPO_DIR", original);
  }
});

Deno.test("resolveRepoDir falls back to cwd when unset", () => {
  const original = Deno.env.get("SWAMP_REPO_DIR");
  try {
    Deno.env.delete("SWAMP_REPO_DIR");
    assertEquals(resolveRepoDir(), Deno.cwd());
  } finally {
    if (original !== undefined) Deno.env.set("SWAMP_REPO_DIR", original);
  }
});

// --- buildInvestigationPrompt: repo-identity line ---------------------------

Deno.test("prompt includes repo and description when both provided", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [humanReviewEvent],
    "octocat/hello-world",
    "Rails app",
  );
  assertStringIncludes(prompt, "Repository: octocat/hello-world (Rails app)");
});

Deno.test("prompt shows repo only when description omitted", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [humanReviewEvent],
    "octocat/hello-world",
    "",
  );
  assertStringIncludes(prompt, "Repository: octocat/hello-world\n");
  assert(
    !prompt.includes("Repository: octocat/hello-world ("),
    "no parenthetical description expected on the repo line",
  );
});

Deno.test("prompt falls back to description-only repo line", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [humanReviewEvent],
    "",
    "internal service",
  );
  assertStringIncludes(prompt, "Repository: internal service");
});

Deno.test("prompt omits repo line entirely when nothing configured", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [humanReviewEvent],
    "",
    "",
  );
  assert(
    !prompt.includes("Repository:"),
    "expected no Repository line when both repo and description are empty",
  );
});

// --- buildInvestigationPrompt: event formatting -----------------------------

Deno.test("human review event renders file, diff, and Human label", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [humanReviewEvent],
    "octocat/hello-world",
    "",
  );
  assertStringIncludes(prompt, "Human: alice (review_comment)");
  assertStringIncludes(prompt, "File: lib/widget.rb:17");
  assertStringIncludes(prompt, "```diff\n- foo\n+ bar\n```");
  assertStringIncludes(prompt, "This nil check looks wrong.");
});

Deno.test("bot check event renders Bot label and check result", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [botCheckEvent],
    "octocat/hello-world",
    "",
  );
  assertStringIncludes(prompt, "Bot: ci-bot (check_run)");
  assertStringIncludes(prompt, "Check: rspec (failure)");
  assertStringIncludes(prompt, "Review state: completed");
});

Deno.test("multiple events are separated by a divider", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [humanReviewEvent, botCheckEvent],
    "octocat/hello-world",
    "",
  );
  assertStringIncludes(prompt, "\n\n---\n\n");
});

Deno.test("prompt embeds the PR number, branch, and JSON contract", () => {
  const prompt = buildInvestigationPrompt(
    42,
    "Add widget",
    "https://example/pr/42",
    "feature/widget",
    [humanReviewEvent],
    "octocat/hello-world",
    "",
  );
  assertStringIncludes(prompt, "PR #42");
  assertStringIncludes(prompt, "git diff origin/main...feature/widget");
  assertStringIncludes(prompt, '"proposedActions"');
});
