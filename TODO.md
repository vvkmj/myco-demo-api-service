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
- [x] **Unblocked**: `action.yml` (composite action) + `dist/index.js`
      (bundled via `@vercel/ncc`) built and verified — every env var the
      code actually reads (`PR_LINK`, `LITELLM_*`, ticket/Jira/GitHub-Issues
      vars, metrics vars, etc.) cross-checked 1:1 against `action.yml`'s
      inputs so nothing is silently dropped; smoke-tested the real bundle
      (graceful exit on missing `PR_LINK`; full env-var wiring exercised
      through to a real outbound GitHub API call). Package (action.yml +
      dist/index.js + README) is built and ready to push to the private repo
      Grege created (`AbhishikaAgarwal/myco-bundled-action`).
      **Still blocking**: no GitHub push credentials for that account exist
      on this machine or in Claude's cloud workspace (checked both — neither
      has a cached credential or `gh` CLI). Needs Grege to either (a) hand
      over a scoped/revocable PAT for that one repo, or (b) push it himself
      from the built package. Decision: **private** repo, clients invited as
      collaborators (not public) — see Cross-client metrics store section,
      this superseded the earlier "public repo" idea once the data-protection
      concern was raised.
- [ ] **Blocking**: multi-provider LLM client. `LiteLLMClient`
      (`src/llm/claudeClient.ts`) only supports OpenAI-compatible
      chat-completions endpoints. UniformBasket may bring a native
      Anthropic/Gemini/other key — needs a second `LLMClient` implementation
      (interface already exists) selected via env, not just an
      OpenAI-compatible proxy assumption.
- [ ] Setup documentation: README's "Getting started" only covers local
      `.env` + `npm start` — no reference for what a consumer's GitHub
      Actions secrets/vars need to be. Needed as source material before
      Grege writes the actual setup doc for UniformBasket.

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
- [ ] **Needs a decision from Grege**: which low-ops backend to actually
      stand up (e.g. Supabase — free tier, managed Postgres + auto REST API,
      no server to run) to receive these POSTs. Claude can't create
      third-party cloud accounts — needs Grege to create the project and
      hand back a URL + key, then Claude wires it in and verifies end-to-end.
- [ ] A small per-client + aggregate dashboard/view once the backend exists
      (even a simple query script or a lightweight page) — not yet built,
      blocked on the backend decision above.
- [x] Private bundled-action distribution repo created by Grege:
      `https://github.com/AbhishikaAgarwal/myco-bundled-action`. Bundle is
      built and ready (see Pilot #2 section) — **blocked on push
      credentials**, see there. Once pushed, Grege still needs to invite
      UniformBasket's GitHub account/org as a collaborator when ready to
      onboard them (private repo, not public).

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
- [ ] Product name still being finalized (Grege + co-founder) — blocks
      anything public-facing (PR bot display name, App listing name,
      `package.json` name, repo rename from `pr-reviewer-agent`/`zenith`).

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
- [ ] Onboarding template/scaffold (secrets/vars checklist + sample workflow)
      so wiring up a new client repo doesn't start from a blank YAML file.

## Phase 2 — Not on Velo pilot's critical path (Action-only for pilot #1)

- [ ] GitHub App: manifest, webhook receiver (signature verification +
      installation-token minting via `@octokit/auth-app`), hosting, async
      job runner (webhook can't block on a multi-minute pipeline),
      per-installation config storage, encrypted secrets store for
      client-supplied BYO keys.
- [ ] Persistent knowledge graph across the codebase (today: a fresh 2-hop
      import-graph walk per PR, discarded after — see `src/code/codeWalker.ts`).
- [ ] Ingestion of linked PRDs/Confluence/meeting transcripts from the PR
      description — the "intent" half of the product's positioning isn't
      wired up; today "intent" is just the PR title/body text.
- [ ] True multi-repo / cross-service dependency tracing (today: a single
      `TARGET_REPO` per run, auto-derived from the PR's own repo unless
      overridden).
