# Myco — Technical Architecture

Myco is an automated SDET (Software Development Engineer in Test) review agent. It runs as a GitHub Actions CI job on every PR, analyses the diff using LLMs, validates findings with a second-pass model, posts inline PR comments, and optionally files Jira tickets. It blocks merges on confirmed P1/BLOCKER bugs.

---

## Tech Stack

| Layer | What |
|---|---|
| Language | TypeScript (Node 20) |
| LLM transport | OpenAI SDK (`openai` npm package) pointed at a **LiteLLM proxy** |
| Review model | `claude-sonnet-4-6` (configurable via `LITELLM_MODEL`) |
| Validator model | `quality/Kimi-K2.6` (configurable via `VALIDATOR_MODEL`) |
| GitHub API | `axios` — REST calls to `api.github.com` |
| Jira API | `axios` — Jira Cloud REST v3 |
| CI | GitHub Actions (`MycoIntelligence/myco-bundled-action@v1` — installed in consumer repos to review their PRs) |

No LangChain, LangFuse, or any agent framework is used. All orchestration is hand-rolled.

---

## Repository Structure

```
src/
  index.ts                  — Entrypoint / orchestrator (the main pipeline)
  llm/
    claudeClient.ts         — LiteLLM client (streaming, tool-call loop, retries)
  github/
    prFetcher.ts            — GitHub diff/PR fetching + line-number annotation
    prCommenter.ts          — GitHub PR review comment posting + deduplication
  repo/
    repoManager.ts          — Git clone / sparse checkout of the target repo
  code/
    codeWalker.ts           — Static import graph walker (builds code context)
  tests/
    testScanner.ts          — Test file discovery and coverage summariser
  review/
    prReviewer.ts           — Prompt builder + LLM call for the SDET review
    finding.ts              — FindingCard type + markdown parser
  validate/
    findingValidator.ts     — Second-pass LLM validator + verdict parser
  tickets/
    ticketCreator.ts        — Jira ticket creator (+ dry-run mode)
  output/
    findingsExporter.ts     — findings.json writer + ticket hash deduplication
```

---

## End-to-End Pipeline

The pipeline runs in `src/index.ts` as a single async `main()`. Steps run sequentially.

### Step 1 — LiteLLM client init
Creates a `LiteLLMClient` using `LITELLM_API_KEY` and `LITELLM_BASE_URL`. All LLM calls go through this single client via the OpenAI-compatible API.

### Step 2 — Fetch diff from GitHub
`src/github/prFetcher.ts` — reads `PR_LINK` (env var) and detects the URL type:
- `github.com/.../pull/123` → fetches PR metadata + file patches via GitHub REST API
- `github.com/.../compare/v1...v2` → fetches tag/branch comparison

Every diff patch is **annotated with absolute line numbers** before being sent to the LLM:
```
+44: added code line
 44: context line
-43: removed line
```
This is the key mechanism that makes the LLM cite correct line numbers in findings — it doesn't need to count from `@@` hunk headers.

Output is a `DiffContext` struct shared by all downstream modules.

### Step 3 — Clone / sparse-checkout target repo
`src/repo/repoManager.ts` — does a `git clone --depth=1 --sparse` of the PR's head branch. Only the folders containing changed files are checked out (sparse checkout). This limits disk usage and speeds up subsequent file reads.

If the directory already exists, it does `git fetch + reset --hard` instead of re-cloning.

### Step 4 — Build static code context (import graph)
`src/code/codeWalker.ts` — walks the import graph of the changed files up to **2 hops deep**. For every source file, it:
1. Reads the file
2. Extracts all relative `import`/`require` statements with a regex
3. Resolves them to absolute paths (handles bare paths, extensions, index files)
4. Recurses up to depth 2

The result is a concatenated block of file contents (capped at 220k chars ≈ 55k tokens) passed into the LLM prompt as "Related Code Context". This lets the LLM see callers and dependencies without issuing tool calls for every file.

### Step 5 — Scan test coverage
`src/tests/testScanner.ts` — discovers test files in 3 ways:
- **Explicit paths** from `UT_PATH`, `IT_PATH`, etc. env vars
- **Auto-discovery** by walking the sparse-checked-out folders and classifying by directory name conventions (`integration/`, `e2e/`, `component/`, `contract/`, `__tests__/`, etc.)
- **Co-located test files** (`.test.ts` / `.spec.ts` next to changed source files)

Extracts test case labels (from `describe()`/`it()`/`test()` calls) and builds a markdown summary injected into the LLM prompt.

### Step 6 — SDET review (first-pass LLM call)
`src/review/prReviewer.ts` — builds a structured prompt and calls the LLM with `repoPath` set, enabling the `read_file` tool.

The prompt instructs the LLM to act as a senior SDET and output **4 sections**:
1. **Executive Summary** — risk level (Low/Medium/High/Critical) + recommendation (Approve/Request Changes/Block)
2. **Findings** — structured finding cards (`BLOCKER-1`, `P1-2`, `P2-3`, `P3-4`), each with: title, file + line, root cause, impact, fix
3. **Test Gaps** — table of missing test scenarios
4. **Regression Risk** — table of flows at risk

The LLM may issue `read_file` tool calls to read additional source files. The client executes these tool calls in a loop until the model stops requesting files. Each tool call is path-traversal guarded (cannot escape the repo root).

The review streams directly to a `.md` file in `./reviews/<owner>_<repo>_<slug>/`.

`MIN_SEVERITY` env var controls the lowest severity the LLM will report (default P3). The prompt explicitly tells the LLM to omit findings below the threshold.

### Step 7 — Parse findings
`src/review/finding.ts` — regex-parses all finding cards out of the review markdown into `FindingCard[]` objects with structured fields (`id`, `severity`, `title`, `filePath`, `line`, `rootCause`, `impact`, `fix`).

An initial `findings.json` is written to disk immediately (before validation).

### Step 8 — Post pre-validation comments (optional)
If `VALIDATE_FINDINGS=false` and `POST_GITHUB_COMMENTS=true`, findings are posted to the PR immediately. This path is skipped when validation is enabled (the system waits for confirmed findings only).

### Step 9 — Second-pass validation (separate LLM call)
`src/validate/findingValidator.ts` — sends **all** parsed findings to the validator model (`VALIDATOR_MODEL`, defaults to `quality/Kimi-K2.6`) in a **single batch call**.

The validator prompt asks the model to read source files and produce a verdict block for each finding:
```
[P1-2]
Verdict: CONFIRMED
Merge-blocking: yes
Confidence: HIGH
Reasoning: getConfig() at line 43 is indeed called unconditionally...
```

Verdict options: `CONFIRMED`, `FALSE_POSITIVE`, `UNCERTAIN`

The validator can also issue `read_file` tool calls. After the response, verdict blocks are regex-parsed and merged back onto the `FindingCard` objects to produce `ValidatedFinding[]`.

The use of a **different model** for validation is intentional — it acts as an independent second opinion to reduce false positives from the review model.

### Step 10 — Check for already-raised findings
`src/github/prCommenter.ts` (`fetchAlreadyRaisedFindings`) — before posting comments or creating tickets, Myco reads existing PR inline review threads and issue comments to detect findings already raised in a previous run. Two mechanisms:

1. **"Jira Tickets Filed" issue comment** — parses `[findingId] → ticketUrl` from a previously-posted summary comment
2. **Inline bot comment threads** — checks if the bot comment already contains a `[Jira ticket](url)` link, or if a developer has replied to the thread (acknowledged)

This prevents duplicate comments and duplicate Jira tickets on PR re-runs.

### Step 11 — Post confirmed inline PR comments
Only `CONFIRMED` findings are posted. The client uses the GitHub Reviews API (`POST /pulls/:pr/reviews`) with:
- **Inline comments** on the exact `file:line` from the finding card
- **`REQUEST_CHANGES` event** if any confirmed finding is merge-blocking (GitHub visually blocks the merge until a maintainer dismisses the review)
- **Fallback** to body-only review if GitHub returns 422 (line not in diff)

### Step 12 — Create Jira tickets
`src/tickets/ticketCreator.ts` — for each `CONFIRMED` + merge-blocking finding:
- Checks the `ticket-hashes.json` deduplication store (SHA-256 hash of `filePath|severity|rootCause[:100]`) to skip already-filed tickets
- Calls Jira Cloud REST v3 `POST /issue` with a structured description (Atlassian Document Format)
- Tries to resolve the PR author's GitHub login to a Jira `accountId` for auto-assignment
- Saves the ticket URL to `ticket-hashes.json` and back-patches it onto the finding

Supports `TICKET_PROVIDER=dry-run` to log what would be created without calling Jira.

### Step 13 — CI gate
If `CI_GATE=true` (default) and any `CONFIRMED` + `mergeBlocking` finding exists at or above `GATE_MIN_SEVERITY` (default P1), the process exits with code 1, blocking the PR merge.

`MIN_SEVERITY` and `GATE_MIN_SEVERITY` are independent:
- `MIN_SEVERITY=P2` → LLM generates and comments P1+P2 findings
- `GATE_MIN_SEVERITY=P1` → only confirmed P1/BLOCKER findings actually block the merge

---

## LLM Client Architecture

`src/llm/claudeClient.ts` — `LiteLLMClient` wraps the OpenAI SDK pointed at LiteLLM:

```
LiteLLMClient.generate(prompt, repoPath?, streamTo?)
    │
    ├── Creates streaming chat completion request
    │     model: LITELLM_MODEL
    │     max_tokens: 32768
    │     temperature: 0
    │     tools: [read_file] (only if repoPath is set)
    │
    ├── Tool-call loop (runs until finish_reason != "tool_calls")
    │     LLM calls read_file(path) → execTool() reads file from repoPath
    │     Result appended to messages → next LLM call
    │
    ├── Streaming → writes chunks to streamTo (file) or stdout
    │
    └── Retry loop (3 attempts, exponential backoff)
          Retries on: ETIMEDOUT, ECONNRESET, ECONNREFUSED, HTTP 429, HTTP 5xx
```

The `ClaudeClient` export is a deprecated alias for `LiteLLMClient` (renamed when LiteLLM proxy was introduced).

---

## Key Design Decisions

**Why LiteLLM proxy instead of direct Anthropic API?**
LiteLLM lets the team swap models without code changes — just set `LITELLM_MODEL`. The review and validation steps currently use different model families (Claude for review, Kimi for validation) routed through the same proxy.

**Why annotate diff lines with absolute numbers?**
Without this, LLMs frequently miscalculate line numbers by counting from `@@` hunk offsets. The annotation (e.g. `+44:`) lets the model cite `line 44` directly, which is what gets used for inline PR comments. This was a deliberate fix for a systematic accuracy problem.

**Why two separate LLM calls (review + validate)?**
The review model generates a broad list of potential bugs. The validator acts as an independent second opinion against the actual source files, filtering out false positives before comments are posted and tickets are filed. Different models are used to reduce correlated errors.

**Why sparse checkout?**
Large repos can be 10GB+. Sparse-checking out only the folders touched by the PR keeps clone time to seconds and keeps the tool-call file reads scoped to relevant code.

**Why hash-based ticket deduplication?**
If a PR is updated and Myco re-runs, the same bugs would generate duplicate Jira tickets. The hash (`sha256(filePath|severity|rootCause[:100])`) is stable across re-runs for the same bug and is stored in `ticket-hashes.json`.

---

## GitHub Actions Integration

### Bundled GitHub Action — Consumer workflow
External repositories install `MycoIntelligence/myco-bundled-action@v1` in their own workflow. The action uses the consumer workflow's automatic `GITHUB_TOKEN` for same-repository GitHub API access; it does not use a GitHub App, GitHub App private key, or legacy third-party credentials.

---

## Environment Variables Reference

| Variable | Required | Description |
|---|---|---|
| `PR_LINK` | Yes | Full GitHub PR or compare URL |
| `LITELLM_API_KEY` | Yes | API key for LiteLLM proxy |
| `LITELLM_BASE_URL` | Yes | Base URL of LiteLLM proxy |
| `GITHUB_TOKEN` | Yes (for comments) | GitHub App token for posting PR comments and reading PR diffs |
| `LITELLM_MODEL` | No | Review model (default: `claude-sonnet-4-6`) |
| `VALIDATOR_MODEL` | No | Validation model (default: `quality/Kimi-K2.6`) |
| `MIN_SEVERITY` | No | Lowest severity to generate (default: `P3`) |
| `GATE_MIN_SEVERITY` | No | Lowest severity that blocks merges (default: `P1`) |
| `VALIDATE_FINDINGS` | No | Enable second-pass validation (default: `false`) |
| `CI_GATE` | No | Exit 1 on confirmed blockers (default: `true`) |
| `POST_GITHUB_COMMENTS` | No | Post inline PR comments (default: `false`) |
| `JIRA_BASE_URL` | No | Jira instance URL (enables ticket creation if set with TOKEN+PROJECT) |
| `JIRA_TOKEN` | No | Jira API token or `email:token` |
| `JIRA_PROJECT` | No | Jira project key (e.g. `ENG`) |
| `TARGET_REPO` | No | Override repo to clone (auto-derived from PR URL) |
| `TARGET_BRANCH` | No | Override branch to clone (auto-derived from PR head) |
| `TARGET_REPO_PATH` | No | Local path for the clone (default: `./target-repo`) |

---

## Output Artifacts

All outputs land in `./reviews/<owner>_<repo>_<slug>/`:

| File | Contents |
|---|---|
| `<slug>_review.md` | Full LLM review (Sections 1–4 + Section 5 validation appended) |
| `findings.json` | Structured findings with verdicts, merge-blocking flags, ticket URLs |
| `ticket-hashes.json` | `hash → ticketUrl` map for deduplication across re-runs |
