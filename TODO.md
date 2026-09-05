# Fix / Build Punch List

Tracking list for hardening this codebase and getting it pilot-ready with Velo
(GitHub Action distribution first; GitHub App tracked separately, not on the
pilot critical path). Updated as items land — see git history for when each
box was checked.

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
- [ ] Generalize ticket creation beyond Jira-only. `TicketCreator` interface
      already exists (`src/tickets/ticketCreator.ts`) — add
      `LinearTicketCreator` (Velo uses Linear) and a `GitHubIssuesTicketCreator`,
      and make `TICKET_PROVIDER` + its credentials fully config/secret-driven
      per client (Jira / Linear / GitHub Issues / dry-run).
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
