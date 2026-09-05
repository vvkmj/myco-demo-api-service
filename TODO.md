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
- [ ] **Blocking**: package as a real `action.yml` + bundle (see Phase 1
      item below) so UniformBasket's CI never checks out this product's
      private source. Decision: public bundled-action repo (compiled/bundled
      JS only, no readable TS source) — standard pattern for distributing a
      GitHub Action, scales to future clients without per-client access
      grants. Requires manually creating the new repo (no `gh` CLI available
      on this machine to automate it) and pushing the bundle.
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

- [ ] Package as a real `action.yml` (composite or Docker) so a consumer
      references `uses: <org>/<action>@v1` instead of checking out this
      product's private source into their CI.
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
