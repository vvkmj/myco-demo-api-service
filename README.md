# Myco Intelligence

An automated **PR review agent** that acts as a senior SDET. Given a GitHub PR URL, it:
1. Fetches the PR diff and metadata from the GitHub API
2. Optionally clones/pulls the target repo (fleet-streams) with sparse checkout scoped to changed folders
3. Scans the repo for existing test coverage (unit, integration, component, contract)
4. Sends everything to an LLM (via LiteLLM proxy) to generate a structured, prioritised code review
5. Writes the review as a Markdown file under `./reviews/<owner>_<repo>_pr<number>/`

**Getting started:**
`npm i`
Add the required env vars
`npm start`


**Entry point:** `npm run start` or `npm run review` — both run `ts-node src/index.ts`

`PR_LINK` accepts **either** a PR URL or a GitHub compare URL:
```
# Pull request
PR_LINK=https://github.com/owner/repository/pull/123

# Tag diff
PR_LINK=https://github.com/owner/repository/compare/v1.2.3...v1.2.4

# Branch compare
PR_LINK=https://github.com/owner/repository/compare/main...feature/my-branch
```

---

## Project Structure

```
src/
├── index.ts              # Main orchestrator — reads .env, wires everything together
├── github/
│   └── prFetcher.ts      # Fetches PR metadata + diff from GitHub REST API
├── llm/
│   └── claudeClient.ts   # LiteLLM client; wraps OpenAI SDK; supports tool-calling loop
├── repo/
│   └── repoManager.ts    # git clone/pull with sparse-checkout of changed folders only
├── tests/
│   └── testScanner.ts    # Walks local test directories; classifies by type; extracts test names
├── code/
│   └── codeWalker.ts     # Follows import graph from changed files; builds code context block
├── review/
│   ├── prReviewer.ts     # Builds the LLM prompt; calls claude; writes output .md file
│   └── finding.ts        # Shared FindingCard type + parseFindings() parser
├── validate/
│   └── findingValidator.ts  # Second-pass validator: confirms/rejects each finding against codebase
├── tickets/
│   └── ticketCreator.ts  # Jira ticket creation + dry-run mode
└── output/
    └── findingsExporter.ts  # Writes findings.json; manages ticket-hashes.json for deduplication
```

**Other files:**
- `.env` / `.env.example` — all runtime config (see Environment Variables below)
- `results/` — previously generated reviews (e.g. `owner_repository_pr123/`)
- `fleet-streams/` — sparse-checked-out clone of the target repo (git-ignored in practice)
- `tsconfig.json` — ES2020, CommonJS, strict mode

---

## Module Responsibilities

### `src/index.ts`
Orchestrator. Flow:
1. Load `.env` via dotenv
2. Instantiate `LiteLLMClient`
3. Call `fetchPRContext(PR_LINK)` → `PRContext`
4. Call `formatPRContext(pr)` → Markdown string of PR metadata + diff
5. Optionally `cloneFleetStreams(repoUrl, branch, repoPath, sparseFolders)` using `deriveSparseFolders(changedFilenames)`
6. Call `autoDiscoverTests(repoPath, sparseFolders)` + `scanTestCoverage(envPaths, [], autoFound)` → `TestCoverage`
7. Call `reviewPR({ pr, prMarkdown, repoPath, testCoverageSummary, outputDir }, claude)` → writes review file

**Note:** `codeWalker.ts` (`buildCodeContext`, `deriveEntryPoints`) is called from `index.ts` to build a static import-graph context block that is embedded in the review prompt alongside the diff. This pre-built context means the LLM starts with caller/callee relationships rather than guessing from the diff alone.

---

### `src/github/prFetcher.ts`
- **`fetchDiffContext(url)`** — single public entry point; detects URL type and routes:
  - `github.com/.../pull/N` → `fetchPRContext()` — calls `/pulls/{N}` + `/pulls/{N}/files`
  - `github.com/.../compare/base...head` → `fetchCompareContext()` — calls `/compare/{base}...{head}`
  - anything else → throws with a helpful error message
- Both return a **`DiffContext`** (unified type):
  - `sourceType: "pr" | "compare"`
  - `prNumber?` — only set for PRs
  - `baseRef / headRef` — branch or tag names
  - `commits[]` — populated for compare, empty for PRs
  - `slug` — filesystem-safe string: `pr123` or `v1.2.3..v1.2.4`
  - `changedFiles`, `diffSummary`, `labels`, `reviewers`, etc.
- Caps each file patch at **8,000 chars**
- `formatDiffContext()` produces Markdown: PR-style header for PRs, commit list + file table for compare
- `PRContext` and `formatPRContext` kept as deprecated aliases for backwards compatibility

---

### `src/llm/claudeClient.ts`
- Class: `LiteLLMClient` (also exported as deprecated alias `ClaudeClient`)
- Uses the **OpenAI SDK** pointed at a LiteLLM proxy (`LITELLM_BASE_URL`)
- Implements a **tool-calling loop**: if the model calls `read_file` or `list_directory`, executes them locally against `repoPath` and feeds results back in a multi-turn conversation
- Path traversal guard: rejects any tool path that escapes `repoPath`
- File read cap: **20,000 chars** per file
- `generate(prompt, repoPath?, streamTo?)`: if `streamTo` (a `fs.WriteStream`) is provided, streams chunks directly to that file and suppresses terminal output; otherwise streams to stdout
- Logs tool calls with `🔧 [tool #N] name(path)`
- Interface: `LLMClient { generate(prompt, repoPath?, streamTo?): Promise<string> }`

---

### `src/repo/repoManager.ts`
- `cloneFleetStreams(repoUrl, branch, targetDir, sparseFolders)`: if dir exists → fetch + hard-reset; if that fails → delete and re-clone from scratch. Uses `--depth=1 --filter=blob:none --sparse` for speed.
- `deriveSparseFolders(changedFilenames)`: extracts unique parent directories from changed file paths → used to limit sparse checkout scope

---

### `src/tests/testScanner.ts`
- `autoDiscoverTests(repoRoot, changedFolders)`: walks changed folders + their parent dirs, classifies test files into unit/integration/component/contract by directory name heuristics
  - `integration|e2e|functional` → integration
  - `component` → component
  - `contract|pact|schema` → contract
  - everything else → unit
  - contract file extensions (`.json`, `.yaml`, `.yml`, `.md`) → always contract
- `scanTestCoverage(paths, changedFiles, autoDiscovered)`: merges env-specified paths with auto-discovered ones, walks each, extracts test case labels with regex (`describe/it/test/context/specify`)
- `discoverColocatedUTs(changedFilePaths)`: looks for `.test.ts` / `.spec.ts` siblings next to changed source files
- Limits: 300 files/type, 60 test cases/file, 200KB max file size

---

### `src/review/prReviewer.ts`
- `reviewPR(input, claude)`: builds prompt → opens a `fs.WriteStream` to the output file → calls `claude.generate(prompt, repoPath, fileStream)` which streams chunks directly to disk as they arrive
- `buildReviewPrompt(...)`: concise prompt (~80 lines) instructing the LLM to act as a senior SDET
- Review output format (4 sections):
  1. **Executive Summary** — 2–3 sentences, Risk Level + Recommendation
  2. **Findings** — one card per issue in this exact structure:
     ```
     [SEVERITY-N] Short title
     File:        path/to/file.ts · lines X–Y
     Root cause:  one sentence
     Impact:      one sentence
     Fix:         concrete code-level change
     ```
  3. **Test Gaps** — table: Priority | Test Type | File/Function | Missing Scenario | What to Assert
  4. **Regression Risk** — table: Flow | Risk | Reason
- `minSeverity` param: if set, the prompt instructs the model to omit findings below that level
- `codeContext` param: if set, the pre-built import-graph context is appended to the prompt

---

### `src/review/finding.ts`
- Shared `FindingCard` interface and `parseFindings()` regex parser
- Used by both `prCommenter.ts` (for GitHub comments) and `findingValidator.ts` (for validation)
- Added `severity` field to `FindingCard` for filtering

---

### `src/validate/findingValidator.ts`
- `validateFindings(findings, diffMarkdown, repoPath, codeContext, claude)` — single batch LLM call validating all findings at once
- The LLM has `read_file` / `list_directory` tool access to verify findings against the real codebase
- Verdicts: `CONFIRMED` / `FALSE_POSITIVE` / `UNCERTAIN`
- Each `ValidatedFinding` gets `mergeBlocking`, `confidence` (`HIGH`/`MEDIUM`/`LOW`), `validatorReasoning`, and a stable 8-char `hash` (sha256 of filePath+severity+rootCause)
- `buildValidationSection(validated)` produces the Section 5 markdown table appended to the review file
- Uses `VALIDATOR_MODEL` env var if set (allows a different/smarter model for validation than the initial review)

---

### `src/tickets/ticketCreator.ts`
- `TicketCreator` interface: `create(finding, prUrl) → Promise<string | null>`
- `JiraTicketCreator` — creates Jira issues via REST API v3 (Atlassian Document Format description); labels include `pr-reviewer`, `auto-generated`, severity
- `DryRunTicketCreator` — logs what would be filed, returns null
- `createTicketCreator(mode)` — factory: `"jira"` or `"dry-run"`
- Auth: `JIRA_TOKEN` supports `email:api-token` (auto-base64), pre-encoded `Basic ...`, or raw `Bearer ...`

---

### `src/output/findingsExporter.ts`
- `writeFindingsJson(outputDir, prUrl, reviewMarkdown, findings, validated)` — writes `findings.json`; always written (before and after validation)
- `FindingsJson` type: includes `prUrl`, `reviewedAt`, `summary` (risk+recommendation extracted from markdown), `findings[]`, `confirmedBlockers[]`, `hasConfirmedBlockers`, `validated`
- `loadTicketHashes / saveTicketHash` — persistent deduplication store in `ticket-hashes.json`; prevents duplicate Jira tickets if the same PR is re-reviewed

---

### `src/code/codeWalker.ts`
- `buildCodeContext(entryPoints, repoRoot)`: walks import graph from changed source files (up to 8 hops deep), concatenates file contents with `=== FILE: path ===` headers; skips test files; discovers test siblings; 220k char budget
- `deriveEntryPoints(changedFilenames, repoRoot)`: filters changedFiles to source-only, non-test files, maps to absolute paths
- Called from `index.ts` — its output (`codeContext`) is embedded in the prompt so the LLM starts with caller/callee context. The LLM can still use `read_file` tool calls for anything not covered by the static walk.

---

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `PR_LINK` | Yes | — | Full GitHub PR URL |
| `GITHUB_TOKEN` | No | — | GitHub PAT (for private repos / rate limits; required if `POST_GITHUB_COMMENTS=true`) |
| `LITELLM_API_KEY` | Yes | — | API key for LiteLLM proxy |
| `LITELLM_BASE_URL` | Yes | — | LiteLLM proxy base URL |
| `LITELLM_MODEL` | No | `gpt-5.5` | Model name for the initial review pass |
| `VALIDATOR_MODEL` | No | same as `LITELLM_MODEL` | Model name for the validator second-pass (can be a smarter/different model) |
| `FLEET_STREAMS_REPO` | No | — | Git URL for fleet-streams repo |
| `FLEET_STREAMS_BRANCH` | No | `main` | Branch to checkout |
| `FLEET_STREAMS_PATH` | No | — | Local path for clone (e.g. `./fleet-streams`) |
| `UT_PATH` | No | — | Comma-separated unit test root paths |
| `IT_PATH` | No | — | Integration test root paths |
| `COMPONENT_TEST_PATH` | No | — | Component test root paths |
| `CONTRACT_TEST_PATH` | No | — | Contract test root paths |
| `OUTPUT_DIR` | No | `./reviews` | Base output directory |
| `MIN_SEVERITY` | No | `P3` | Minimum severity to include (`BLOCKER` / `P1` / `P2` / `P3`) |
| `POST_GITHUB_COMMENTS` | No | `false` | If `true`, posts BLOCKER+P1 findings as inline PR review comments |
| `VALIDATE_FINDINGS` | No | `false` | If `true`, runs a second-pass validator LLM call to confirm/reject each finding |
| `CREATE_TICKETS` | No | `false` | If `true`, creates tickets for confirmed findings |
| `TICKET_PROVIDER` | No | `dry-run` | Ticket backend: `jira` or `dry-run` (logs only) |
| `TICKET_MIN_SEVERITY` | No | `P1` | Only create tickets for findings at this severity or above (`BLOCKER` / `P1` / `P2` / `P3`) |
| `JIRA_BASE_URL` | No* | — | Jira instance URL, e.g. `https://yourorg.atlassian.net` |
| `JIRA_TOKEN` | No* | — | Jira auth: `email:api-token` (will be base64 encoded) or pre-encoded `Basic ...` / `Bearer ...` |
| `JIRA_PROJECT` | No* | — | Jira project key, e.g. `FS` |
| `JIRA_ISSUE_TYPE` | No | `Bug` | Jira issue type name |
| `CI_GATE` | No | `true` when `VALIDATE_FINDINGS=true` | If `true`, exits with code 1 when confirmed merge-blocking bugs are found |

*Required when `TICKET_PROVIDER=jira`

---

## Data Flow

```
PR_LINK (.env)  ← PR URL  OR  compare URL
    │
    ▼
fetchDiffContext()  ──── detects URL type ────┬── fetchPRContext()      (PR)
                                              └── fetchCompareContext()  (compare)
    │
    ▼  DiffContext { sourceType, slug, changedFiles[], commits[], ... }
    │                    │
    │             deriveSparseFolders()
    │                    │
    ▼                    ▼
formatDiffContext()   cloneFleetStreams()  ──►  local fleet-streams clone
    │                    │
    │             deriveEntryPoints()
    │             buildCodeContext()      ──►  codeContext (import graph)
    │                    │
    │             autoDiscoverTests()
    │             scanTestCoverage()
    │                    │
    ▼                    ▼
buildReviewPrompt(diffMarkdown, codeContext, testCoverageSummary)
    │
    ▼
LiteLLMClient.generate(prompt, repoPath, fileStream)
    ├── [tool_call: read_file / list_directory]  ◄──► local repo files
    └── streams chunks → file on disk as they arrive
    │
    ▼
<slug>_review.md  (Sections 1–4)

    │  (if POST_GITHUB_COMMENTS=true)
    ├──► postReviewComments()  ──►  GitHub Reviews API
    │
    │  (always)
    ├──► parseFindings() → FindingCard[]
    ├──► writeFindingsJson() → findings.json  (unvalidated)
    │
    │  (if VALIDATE_FINDINGS=true)
    ├──► validateFindings(findings, diff, codeContext, validatorClaude)
    │       └── single batch LLM call with read_file tool access
    │           → ValidatedFinding[] { verdict, mergeBlocking, confidence, reasoning, hash }
    │
    │  (if CREATE_TICKETS=true && TICKET_PROVIDER=jira)
    │   for each CONFIRMED finding at/above TICKET_MIN_SEVERITY:
    ├──► JiraTicketCreator.create()  ──►  Jira REST API
    │       └── deduplication via ticket-hashes.json
    │
    │  (if VALIDATE_FINDINGS=true)
    ├──► append Section 5 (validation table) to <slug>_review.md
    ├──► overwrite findings.json with validated + ticket URLs
    │
    │  (if CI_GATE=true && confirmed blockers exist)
    └──► process.exit(1)
```

---

## Key Design Decisions

- **LiteLLM proxy** instead of Anthropic SDK directly — `claudeClient.ts` uses the OpenAI SDK with a custom `baseURL`, so any OpenAI-compatible backend works
- **Static import graph + on-demand tool calls** — `codeWalker.ts` embeds caller/callee context in the prompt upfront; the LLM can still use `read_file` tool calls to drill deeper. Best of both: the model starts informed, not guessing.
- **Card-per-finding format** — each finding has exactly five fields (title, file, root cause, impact, fix). No prose sections, no duplicate reformatting. Keeps output dense and actionable.
- **Streaming to file** — `generate()` accepts an `fs.WriteStream`; chunks go straight to disk as they arrive. Terminal is silent during generation; only progress lines (tool calls, done) are printed.
- **MIN_SEVERITY filter** — the prompt itself is parameterised with the threshold so the model never generates findings below the requested level, rather than post-filtering.
- **GitHub PR comments** — `prCommenter.ts` parses finding cards from the review markdown and posts BLOCKER+P1 as inline review comments, P2/P3 as a single review body, using the GitHub Reviews API. Guarded: throws immediately if called with a compare `DiffContext`.
- **Sparse checkout** — only checks out the directories touched by the PR, not the full repo
- **Test auto-discovery** — walks changed folders + parent dirs to find tests without needing manual `UT_PATH` config
- **Patch cap at 8k chars/file** — prevents single large diffs from overwhelming the context

---

## Output

Reviews are written to: `./reviews/<owner>_<repo>_<slug>/<slug>_review.md`

| Input type | Example slug | Output path |
|---|---|---|
| PR #123 | `pr123` | `./reviews/owner_repository_pr123/pr123_review.md` |
| Tag diff v1.2.3…v1.2.4 | `v1.2.3..v1.2.4` | `./reviews/owner_repository_v1.2.3..v1.2.4/v1.2.3..v1.2.4_review.md` |

Example existing outputs:
- `results/owner_repository_pr123/`

The target repository is derived from the pull-request or compare URL unless overridden.
