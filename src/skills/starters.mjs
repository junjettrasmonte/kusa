/**
 * Built-in starter skills. Seeded non-destructively into the canonical store.
 */

function skill(name, description, category, body) {
  return {
    starterId: name,
    name,
    description,
    category,
    body: body.trim() + '\n',
  };
}

export const STARTER_SKILLS = [
  skill(
    'agentic-coding-workflow',
    'Guide an agent through reliable end-to-end implementation: clarify, explore, plan when needed, implement minimally, verify, and report. Use for feature work, bug fixes, and multi-step coding tasks.',
    'workflow',
    `# Agentic Coding Workflow

Use this skill for implementation work. Prefer small, verified changes over speculative rewrites.

## 1. Understand the request

- Restate the goal in one or two sentences.
- Identify ambiguities that would change the design or acceptance criteria.
- Ask **one focused question** when a critical requirement is unclear. Do not block on polish preferences.
- Skip heavy planning for trivial, localized changes (typo, one-line fix, obvious rename).

## 2. Explore before editing

- Locate the relevant modules, entry points, and existing tests.
- Prefer targeted reads and searches over dumping entire directories into context.
- Note established patterns (naming, error handling, data access, UI conventions) and reuse them.

## 3. Map dependencies

- Identify callers, callees, shared types, and configuration that the change will touch.
- Call out external contracts (APIs, CLI flags, persisted formats) that must stay compatible.

## 4. Plan when non-trivial

For non-trivial work, write a **concise, checkable** plan (short bullets). Each step should be verifiable.
Do not produce a long design doc for a small change.

## 5. Implement the smallest appropriate change

- Prefer the narrowest diff that satisfies the request.
- Avoid drive-by refactors, speculative abstractions, and unrelated cleanup.
- Match existing style; do not introduce a parallel architecture.

## 6. Verify

- Run the relevant tests, linters, and typechecks for the touched area.
- **Do not claim tests passed unless they actually ran** in this session.
- If you cannot run a check, say so and report what remains unverified.

## 7. Inspect the final diff

- Review for unintended file changes, debug leftovers, and secrets.
- Confirm the diff matches the plan (or explain deliberate deviations).

## 8. Report

Summarize:

1. What changed (files / behavior)
2. How it was verified (commands and outcomes)
3. Unresolved risks or follow-ups

## Anti-patterns

- Guessing instead of exploring
- Planning theater for trivial edits
- Claiming green CI without running checks
- Expanding scope without agreement
`,
  ),

  skill(
    'codebase-exploration',
    'Help an agent understand and explain an unfamiliar or existing codebase: map structure, trace execution, separate facts from assumptions, and cite real source. Use before proposing changes to code you have not inspected.',
    'exploration',
    `# Codebase Exploration and Explanation

Use this skill when the task is to understand, explain, or orient in a codebase—especially before changing it.

## Goals

- Build a grounded mental model from **actual source**, not guesses.
- Prefer targeted exploration over loading entire trees into context.
- Explain behavior **before** proposing changes unless the user only wants a change.

## Process

### 1. Discover structure and entry points

- Identify package layout, apps/services, and how the project is run (scripts, CLI, servers).
- Find main entry files, routers, and configuration roots.
- Note build/test tooling that reveals module boundaries.

### 2. Trace execution paths

- Follow a concrete path: request → handler → domain → storage (or equivalent).
- Cross files and modules; record the symbols that connect them.
- Stop when the behavior under question is explained; avoid encyclopedic dumps.

### 3. Map dependencies and data flow

- Interfaces, shared types, events, and persistence shapes.
- External systems (APIs, queues, agent harnesses) and where they are adapted.

### 4. Locate tests and config

- Find tests that lock the behavior you are describing.
- Note env vars, feature flags, and config files that alter runtime paths.

### 5. Separate facts from assumptions

- Label claims as **verified** (with file/symbol citations) or **assumed**.
- If something is unclear, say what you would inspect next.

### 6. Explain with citations

- Cite relevant file paths and symbol names in the response.
- Prefer short code references over paraphrasing critical logic incorrectly.

## Output shape

1. What this area does (1 short paragraph)
2. Key entry points and flow (bullets with paths)
3. Important invariants or contracts
4. Open questions / assumptions

## Anti-patterns

- Dumping directory listings as “understanding”
- Proposing refactors before explaining current behavior
- Stating unverified architecture as fact
`,
  ),

  skill(
    'debugging-root-cause',
    'Diagnose issues systematically: reproduce, collect evidence, form competing hypotheses, apply a minimal fix, add regression coverage, and report remaining uncertainty. Use for bugs, failures, and unexpected behavior.',
    'debugging',
    `# Debugging and Root-Cause Analysis

Use this skill when something is wrong. Do not guess a fix and hope.

## Process

### 1. Reproduce

- Restate the observed vs expected behavior.
- Reproduce locally or in the closest available environment when possible.
- Record exact steps, inputs, and environment notes.

### 2. Collect evidence

- Capture relevant logs, stack traces, error codes, and failing assertions.
- Prefer primary evidence over speculation from similar-looking past bugs.

### 3. Trace to cause

- Narrow the failure to a layer (input → boundary → core → output).
- Identify the first point where state or control flow diverges from expectation.

### 4. Hypotheses

- List 2–3 competing hypotheses consistent with the evidence.
- Design the smallest check that would falsify each.
- Discard hypotheses that fail those checks; do not “fix around” them.

### 5. Minimal fix

- Change only what is required to correct the root cause.
- Do not suppress errors, weaken assertions, or alter unrelated behavior to hide the failure.

### 6. Regression coverage

- Add or update a test that fails without the fix and passes with it, when practical.
- If a test cannot be added, document how the failure was verified manually.

### 7. Verify resolution

- Confirm the original failure is gone.
- Run nearby tests for collateral damage.

### 8. Report uncertainty

- State what remains unverified (other platforms, race windows, missing prod data).

## Anti-patterns

- Shotgun changes without a failing reproduction
- Catching and swallowing errors to “fix” symptoms
- Disabling or loosening tests to get a green run
- Large refactors mid-debug without a clear causal link
`,
  ),

  skill(
    'software-architecture',
    'Help agents make and explain sound architectural decisions: requirements, boundaries, alternatives, trade-offs, and migration risk. Prefer established project patterns. Use for design choices and significant structural changes.',
    'architecture',
    `# Software Architecture and Design

Use this skill when the work involves structure, boundaries, or lasting design choices—not for trivial local edits.

## Process

### 1. Requirements and constraints

- Functional goals, non-functionals (latency, safety, operability), and hard constraints (existing APIs, harnesses, deployment).
- Clarify what must not change.

### 2. Current boundaries

- Map modules, ownership lines, and dependency directions as they exist today.
- Identify accidental coupling and intentional extension points.

### 3. Alternatives

- Compare at least two viable options when the decision is significant.
- Include “keep current structure with a small adapter” as an option when it is viable.

### 4. Trade-offs

Discuss explicitly:

- Complexity and cognitive load
- Performance and resource use
- Reliability and failure modes
- Security and trust boundaries
- Maintainability and testability

### 5. Prefer established patterns

- Match the project’s existing architecture unless there is a clear, evidenced reason to diverge.
- Avoid speculative frameworks and unnecessary abstractions (“just in case”).

### 6. Migration and compatibility

- Call out rollout steps, dual-write/read needs, and backward-compatibility risks.
- Prefer incremental migration paths over big-bang rewrites when practical.

### 7. Decide and record

For significant changes, present a **concise recommendation and rationale before implementing** when practical.
Record important decisions (short ADR-style note or comment in the PR description) when the choice will be hard to reverse.

## Anti-patterns

- Introducing a new layer without a concrete pain it removes
- Redesigning unrelated areas “while we are here”
- Optimizing for hypothetical future requirements
`,
  ),

  skill(
    'code-review-regression',
    'Review changes for correctness and unintended consequences: read the diff, prioritize bugs and security/data risks, check tests and API compatibility, and report findings with severity and file references. Use when reviewing PRs or pre-merge diffs.',
    'review',
    `# Code Review and Regression Analysis

Use this skill to review a change set. Ground findings in the diff and surrounding code.

## Process

### 1. Read the diff

- Do not rely only on a summary or PR description.
- Skim for scope: which behaviors and contracts actually changed?

### 2. Prioritize real risk

Focus first on:

- Concrete bugs and logic errors
- Security issues (injection, authz, secrets, path traversal)
- Regressions and broken invariants
- Data-integrity and persistence mistakes

Suggestions and style nits come after, and only if useful.

### 3. Check the hard edges

Where relevant, inspect:

- Error handling and failure paths
- Boundary conditions and validation
- Concurrency / races / shared state
- Resource lifecycle (handles, timers, temp files)

### 4. Tests

- Verify coverage for the changed behavior.
- Note missing regressions that would have caught the risk you found.

### 5. Compatibility

- Check public APIs, CLI flags, events, and persisted formats against existing consumers.
- Flag breaking changes explicitly.

### 6. Be precise

- Distinguish **confirmed defects** from **suggestions**.
- Avoid speculative findings unsupported by evidence in the diff or call graph.

### 7. Report

For each finding include:

- Severity (blocker / high / medium / low / nit)
- File and line (or symbol) reference
- Why it matters
- A concrete fix direction when obvious

## Anti-patterns

- Rubber-stamping from the commit message alone
- Flooding the review with unsupported hypotheticals
- Blocking on pure style when no project rule is violated
`,
  ),
];

export function starterById(starterId) {
  return STARTER_SKILLS.find((s) => s.starterId === starterId) || null;
}
