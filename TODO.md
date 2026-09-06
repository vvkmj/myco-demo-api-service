# Fix / Build Punch List

Tracking list for hardening this codebase and getting it pilot-ready with Velo
(GitHub Action distribution first; GitHub App tracked separately, not on the
pilot critical path). Updated as items land — see git history for when each
box was checked.

Commit `5bed01a` — "Fix shell-injection and path-traversal bugs; untrack
secrets/fixture" — landed the three checked Phase 0 items below. Verified
before that commit: fresh `npm ci` + `tsc --noEmit` clean, plus standalone
scripts exercising the actual shipped functions (11/11 checks passing,
including a side-by-side repro of the path-traversal bug against the
pre-fix code to confirm it was really exploitable, not just theoretical).

## Pilot #2 — UniformBasket (external, self-serve, private repo)

Second pilot client, free, self-serve setup on their own private repo —
different shape from Velo's pilot (white-glove, Action-only, same org).
Decisions made for this one: distribution should NOT require checking out
this product's private source (see Phase 1 action.yml item — now blocking,
not just "nice to have"); UniformBasket brings their own LLM key but not
necessarily an OpenAI-compatible one (any provider) — the current
`LiteLLMClient` only speaks the OpenAI-compatible chat-completions shape,
so a native-Anthropic/Gemini/etc. key needs a provider abstraction, not yet
built; client-visible UX is GitHub inline PR comments only, but GitHub
Issues are filed in parallel (using the client's own GITHUB_TOKEN, no extra
secret) purely so confirmed-bug counts are queryable for metrics later.

- [x] `GitHubIssuesTicketCreator` added (`src/tickets/ticketCreator.ts`) —
      files a GitHub Issue per confirmed finding in the same repo being
      reviewed, labeled `zenith-confirmed-bug` + severity, using the
      already-available `GITHUB_TOKEN` (no new secret). Factory and
      `TICKET_PROVIDER` type extended to `"github-issues"`.
- [x] New `CREATE_TICKETS_FOR` env var (`merge-blocking` default |
      `all-confirmed`) — decouples "which findings get a ticket" from
      provider choice, since GitHub Issues here is for metrics (all
      confirmed bugs) not just merge-blockers. CI gate logic (which PRs
      actually get blocked) is unchanged — still merge-blocking-confirmed
      only, independent of ticket scope.
- [x] Workflow: added `issues: write` to `permissions:` (required for the
      GitHub Issues API call) and wired the new env vars through.
- [x] **Done**: `action.yml` (composite action) + `dist/index.js` (bundled
      via `@vercel/ncc`) built, verified, and pushed by Grege to
      `AbhishikaAgarwal/myco-bundled-action` (private repo, collaborators
      invited per-client — not public). Every env var the code reads is
      cross-checked 1:1 against `action.yml`'s inputs; smoke-tested the real
      bundle (graceful exit on missing `PR_LINK`; full env-var wiring
      exercised through to a real outbound GitHub API call).
      **Follow-up push done**: found and fixed a real bug in the process —
      Grege's first push had `index.js` at the repo root instead of
      `dist/index.js`, which `action.yml`'s `run:` step expects; would have
      failed for any client at runtime. Fixed directly in his local clone
      (device bridge write) along with adding the multi-provider LLM inputs
      (`llm_provider`, `anthropic_api_key`, `anthropic_model`,
      `anthropic_base_url`) and `product_label` (see Phase 0 below). Pushed
      and confirmed `HEAD == origin/main`, no unpushed commits.
- [x] **Unblocked**: multi-provider LLM client. Added `AnthropicClient`
      (`src/llm/anthropicClient.ts`) — native Anthropic Messages API,
      implementing the same `LLMClient` interface, reusing the exact same
      `executeTool()`/path-safety code and retry policy as `claudeClient.ts`
      (imported, not duplicated, so the two can't silently diverge). New
      `src/llm/llmClientFactory.ts` picks the implementation via
      `LLM_PROVIDER` env var (`"openai"` default — zero behavior change for
      existing configs — or `"anthropic"`). `src/index.ts` now goes through
      the factory at both call sites (main + validator model) instead of
      constructing `LiteLLMClient` directly. Note: Gemini doesn't need this —
      it already works through the existing OpenAI-compatible path via its
      own compatibility endpoint. 20/20 checks passing (mocks the Anthropic
      SDK's `messages.stream`, not a live call): constructor validation,
      correct default/override model selection, the full tool-use round-trip
      (proves `executeTool()` reuse — including the path-traversal guard —
      holds for this provider too), retryable-vs-fatal error handling, and
      all factory branches including the unknown-provider error.
- [x] Setup documentation: `ONBOARDING.md` — collaborator-invite
      reminder, exact client-side secrets table, copy-paste workflow YAML
      (minimal + Anthropic/GitHub-Issues/Jira/metrics variants), what to
      expect, and known limitations. Source material for Grege's
      UniformBasket-facing doc, or usable close to as-is.

## Cross-client metrics store

Decision: private bundled-action repo (not public) — invite each pilot
client as a collaborator rather than making the tool publicly visible.
Metrics payload privacy level: counts + finding summaries (title, severity,
verdict, mergeBlocking) — no file paths, no root cause/impact/fix text, no
code. Backend: starting fresh, low-ops.

- [x] `src/output/metricsReporter.ts` — opt-in (no-op unless
      `METRICS_ENDPOINT` set), backend-agnostic POST of the agreed-minimal
      payload. `client_id` supports per-client + aggregate-across-clients
      rollups downstream. 18/18 tests passing, including explicit assertions
      that sensitive fields never appear in the serialized payload.
- [x] Grege created the Supabase project:
      `https://liuxmyrceaurpsjiatfk.supabase.co` (publishable key on hand).
      **Design decision**: do NOT point `METRICS_ENDPOINT` straight at
      Supabase's auto-generated REST API — PostgREST needs an `apikey`
      header (not just `Authorization: Bearer`) which `metricsReporter.ts`
      doesn't send, and it would leak Supabase-specific shape into every
      client's CI config. Instead: a Supabase Edge Function as the receiver
      (this was the plan the code comments already called out — "a
      serverless function, a Supabase edge function, anything"). The edge
      function validates `Authorization: Bearer <METRICS_API_KEY>` (a
      secret we set, independent of Supabase's own keys) and inserts into
      the metrics table using the service-role key (auto-injected into edge
      functions, never exposed to clients). Keeps `METRICS_ENDPOINT`/
      `METRICS_API_KEY` fully backend-agnostic from every client's side.
      **Done**: SQL schema (`supabase/schema.sql` — table + RLS +
      per-client/aggregate rollup views) and the edge function
      (`supabase/functions/ingest-metrics/` — `handler.ts` is the tested
      pure logic, 26/26 checks against auth rejection, every payload
      validation edge case, and DB row mapping; `index.ts` is the thin Deno
      wrapper; `index.dashboard.ts` is a generated single-file version for
      pasting straight into the Supabase dashboard, no CLI needed) are
      written and in the repo. Full deploy steps in `supabase/README.md`.
      **Done**: Grege ran the SQL, deployed `ingest-metrics` via the
      dashboard (pasting `index.dashboard.ts`), and set `METRICS_INGEST_KEY`.
      Hit two real deploy snags along the way, both fixed: (1) Supabase's
      own gateway rejects any `Authorization` header that isn't a real
      Supabase JWT *before* our function's own bearer-token check ever
      runs — surfaced as a live 401 `UNAUTHORIZED_INVALID_JWT_FORMAT`; fixed
      by turning off "Enforce JWT Verification" for this function in the
      dashboard, since we intentionally use our own bearer-token auth
      instead of a Supabase key. (2) Windows/PowerShell argument-quoting
      mangled the JSON payload in curl's `-d` a few different ways; fixed by
      writing the JSON to a file and using `--data-binary @file`, which
      sidesteps PowerShell-to-native-argv quoting entirely. Live
      smoke-tested from Grege's machine: confirmed `HTTP 200 {"ok":true}`
      and a matching row in `pr_review_metrics`. **Deployed URL**:
      `https://liuxmyrceaurpsjiatfk.supabase.co/functions/v1/ingest-metrics`
      — this is what goes into a client's `METRICS_ENDPOINT` secret,
      paired with `METRICS_API_KEY` = the `METRICS_INGEST_KEY` value.
- [ ] A small per-client + aggregate dashboard/view once the backend exists
      (even a simple query script or a lightweight page) — not yet built,
      blocked on the backend decision above.
- [x] Private bundled-action distribution repo created by Grege and
      pushed: `https://github.com/AbhishikaAgarwal/myco-bundled-action`.
      **Currently public, temporarily** — a collaborator invite alone
      doesn't let a different account's `GITHUB_TOKEN` resolve a private
      `uses:` reference (discovered when the co-founder's test repo
      failed with "repository not found"); see the Phase 2 GitHub App
      item for the real fix and the PAT alternative. Switch back to
      private (with a PAT per client) once that decision is made — don't
      leave it public by default for a real external client without
      revisiting this.

## Phase 0 — Security / correctness fixes (blocking any real run)

- [x] Shell-injection risk in `src/repo/repoManager.ts` — `execSync` with
      string-interpolated branch names/URLs from PR metadata. Fixed: switched
      to `execFileSync` with argument arrays + a guard rejecting values that
      look like CLI flags (argument injection).
- [x] Path-traversal guard bug in `src/llm/claudeClient.ts` `executeTool()` —
      the old `target.startsWith(resolvedRoot)` check was bypassable by a
      sibling directory whose name has the repo root as a string prefix
      (e.g. `target-repo` vs. `target-repo-secrets`). Fixed: now requires an
      exact match or a path-separator boundary.
- [x] Hardcoded `owner: motorq` / `repository: motorq/zenith` in
      `.github/workflows/zenith.yml` — the consumer workflow always pulled
      this product's own private source into whichever repo installed it.
      Partial fix: parametrized via `vars.ZENITH_APP_OWNER` /
      `vars.ZENITH_SOURCE_REPO` / `vars.ZENITH_SOURCE_REF` so onboarding a
      new repo is a config change, not a YAML edit. Real fix is still
      Phase 1's action.yml packaging (see below) — this workflow still
      checks out source rather than referencing a published action.
- [x] `target-repo/` (a stale sparse-checkout of `motorq/fleet-streams`,
      unrelated to this product) was tracked in git despite the README
      describing it as ephemeral/git-ignored-in-practice. It got wiped from
      disk mid-session (likely by an interrupted `npm install` — root cause
      unconfirmed) and, per decision, was left deleted rather than restored:
      untracked via `git rm -r --cached target-repo` and added to
      `.gitignore`. It regenerates automatically the next time the reviewer
      runs against a real PR (see `cloneTargetRepo()`).
- [x] **New finding, critical**: `.env` was committed to git (tracked
      alongside `target-repo/`, same root cause — no `.gitignore` existed at
      all before this session). Untracked via `git rm --cached .env` and
      added to `.gitignore`. Whatever credentials were ever in that file's
      committed versions must be treated as compromised and rotated —
      untracking does not remove them from git history.
- [x] **Found while auditing for "integrate right away" readiness**:
      the still-unfinalized "Zenith" codename was leaking into
      client-visible output — a hardcoded `zenith-confirmed-bug` GitHub
      Issues label, and `["Zenith", "pr-reviewer-agent", ...]` Jira labels.
      A client (Velo, UniformBasket) using either ticket provider would
      have seen the internal codename directly in their own issue tracker.
      Fixed: both now derive from one `PRODUCT_LABEL` env var (default
      neutral `"ai-code-review"`, no product name baked in) — wired through
      `myco-bundled-action`'s `action.yml` as `product_label` and
      `zenith.yml`'s `ZENITH_PRODUCT_LABEL` var. 8/8 new checks
      (`test-jiraTicketCreator.ts`) plus the existing GitHub Issues test
      updated. Checked every other "Zenith" occurrence in the codebase —
      the rest are code comments and the console banner ("PR Reviewer
      Agent" — generic, not the codename), nothing else client-visible.
      **Resolved**: product name finalized — **Myco**. `PRODUCT_LABEL`
      default updated to `"myco"` everywhere (`ticketCreator.ts`,
      `action.yml`, `myco-bundled-action`'s README, `ONBOARDING.md`,
      `zenith.yml` comment), console banner now says "Myco PR Reviewer",
      `package.json` name is `myco-pr-reviewer`. Verified via cloud mirror
      before committing: clean typecheck, both ticket-creator test suites
      updated and passing (26 checks). Also rebuilt the bundle with
      `ncc -m` (minified, 2.34MB → 1.27MB) while in there — closes part of
      the code-exposure gap (see below), though string literals/prompts are
      still plainly readable in the bundle regardless (minification only
      mangles names, not string content — confirmed directly: grepped the
      review system prompt text out of the minified `dist/index.js`).
      **Still open (cosmetic, not blocking)**: repo rename from
      `pr-reviewer-agent`/`zenith` (this private source repo — clients never
      see it, so genuinely low priority), an App listing name if/when the
      GitHub App is built.
      None of these block integrating with a client today.

## Phase 1 — Needed for a credible pilot (not just a hacked demo)

- [x] Package as a real `action.yml` (composite) so a consumer references
      `uses: AbhishikaAgarwal/myco-bundled-action@v1` instead of checking out
      this product's private source into their CI. Built, verified, not yet
      pushed — see Pilot #2 section for the credential blocker.
- [x] `GitHubIssuesTicketCreator` added (see Pilot #2 section above).
      `TICKET_PROVIDER` is now `jira | github-issues | dry-run`, fully
      config-driven per client.
- [ ] `LinearTicketCreator` (Velo uses Linear) — not yet built, not currently
      blocking either pilot (Velo's pilot hasn't started running against a
      real repo yet; UniformBasket wants GitHub Issues, not Linear).
- [ ] Confirm the BYO-key path (`LITELLM_BASE_URL` / `LITELLM_API_KEY` /
      `LITELLM_MODEL` pointed at a client-owned endpoint) works end-to-end —
      likely already works given `claudeClient.ts`'s design, needs testing
      not new code.
- [ ] Durable output storage — findings currently only land in
      `./reviews/**` on the CI runner, uploaded as a 30-day GitHub Actions
      artifact (`retention-days: 30` in the workflow). Needs a persistent
      store so "bugs caught" evidence survives long enough to prove pilot
      value.
- [x] Onboarding template/scaffold — see `ONBOARDING.md` (Pilot #2
      section above has the full breakdown).

## Phase 2 — Not on Velo pilot's critical path (Action-only for pilot #1)

- [ ] GitHub App: manifest, webhook receiver (signature verification +
      installation-token minting via `@octokit/auth-app`), hosting, async
      job runner (webhook can't block on a multi-minute pipeline),
      per-installation config storage, encrypted secrets store for
      client-supplied BYO keys. Rough estimate for an MVP (no client-facing
      settings UI): 4-7 focused days — half a day each for app
      registration/manifest, webhook receiver, and installation-token
      minting; ~1 day for async execution (cheapest path: webhook triggers
      our own GH Actions workflow via `repository_dispatch` rather than a
      hand-rolled job queue); half a day to a day swapping `prCommenter.ts`
      to post via the installation token; half a day for per-installation
      config (reusing the existing Supabase project); a day+ for a real
      encrypted secrets store if clients stop managing their own key in
      their own repo secrets; a day minimum for live end-to-end testing.
      **Real, not just an incremental fix**: this replaces the whole
      distribution model (client installs the App, no workflow YAML, no
      `uses:` reference at all) and would also be the actual fix for the
      black-box code-exposure gap, since the bundle would never leave our
      server. Sequence after BYO-key and ticket-creation get their first
      live confirmation.
      **Trigger for this**: found 2026-09 while onboarding the first test
      client — a private action repo referenced via `uses:` from a
      *different* GitHub account does not resolve using the automatic
      `GITHUB_TOKEN`, even with the consuming account invited as a
      collaborator (confirmed against GitHub's own docs: the built-in
      "share a private action" setting only extends to other repos owned
      by the *same* account/org, not a genuinely different one). Until
      this is built, the two working options are: (a) make
      `myco-bundled-action` public — simplest, but drops the "only invited
      clients can see the bundle" boundary (the bundle's actual protection
      against a determined reader was already weak either way — see the
      product_label/minification commit) — or (b) issue each client a
      fine-grained, read-only, single-repo Personal Access Token and have
      their workflow `actions/checkout` the action repo with it before
      referencing it locally (`uses: ./`). **Decision for the first real
      external client, not yet made**: PAT per client (works today, some
      ongoing issue/rotate overhead) vs. wait for the GitHub App (no
      overhead per client, bigger upfront build). For now (internal
      testing only, co-founder's dummy repo): went public.
- [ ] Persistent knowledge graph across the codebase (today: a fresh 2-hop
      import-graph walk per PR, discarded after — see `src/code/codeWalker.ts`).
- [x] **Intent checking** — the reviewer now reads the PR description as
      stated intent, follows up to 3 links found in it (best-effort,
      SSRF-guarded), and explicitly checks the diff against that intent,
      flagging mismatches as normal findings ("Intent mismatch: ...") —
      same card format, so no downstream changes needed (parsing, inline
      comments, CI gate, tickets, metrics all already handle it).
      `src/intent/linkFetcher.ts`. Toggle: `FOLLOW_INTENT_LINKS` /
      `follow_intent_links` (default true). 24/24 + 13/13 new checks
      passing (URL extraction, SSRF guard incl. redirect re-validation,
      HTML stripping, prompt assembly against the real reviewPR() path),
      full suite (89 checks) still green. Bundle rebuilt and pushed to
      `myco-bundled-action`.
      **Real limitation, not solved**: most linked docs teams actually
      use — Notion, Linear, Jira Cloud, Confluence — are auth-gated or
      client-rendered, so an unauthenticated fetch usually can't read
      them; those surface as "referenced but unread" rather than being
      silently ignored or guessed at, but the actual content still isn't
      read. A team whose specs live in one of those tools gets full
      benefit only if the PR description itself restates the key intent
      in plain text. Proper support for those tools would need
      per-client OAuth/API tokens for each one — a real, separate
      integration project, not attempted here.
      **Still unverified**: a live LLM call actually catching a real,
      deliberate intent/implementation mismatch — the deterministic
      pieces (fetching, prompt assembly) are tested; whether the model
      reliably reasons about intent alignment well needs one real test
      run against a PR with a deliberate mismatch.
- [ ] True multi-repo / cross-service dependency tracing (today: a single
      `TARGET_REPO` per run, auto-derived from the PR's own repo unless
      overridden).
