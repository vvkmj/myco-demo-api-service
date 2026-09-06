# Onboarding a new client

Checklist + copy-paste workflow for wiring this reviewer into a new
client's repo via the bundled GitHub Action (`myco-bundled-action`). This
is the self-serve path — no GitHub App, no source checkout, no access to
this product's private code.

## 0. Before the client touches anything

- [ ] Invite the client's GitHub account/org as a **collaborator** on
      `AbhishikaAgarwal/myco-bundled-action` (it's private — their CI can't
      resolve `uses: AbhishikaAgarwal/myco-bundled-action@v1` without this).
- [ ] Product name is finalized: **Myco**. Tickets get a `myco` /
      `myco-confirmed-bug` label by default — override per-client via
      `product_label` only if they want their own label scheme instead.

## 1. Client-side secrets (repo Settings → Secrets and variables → Actions)

Always required:

| Secret | Notes |
|---|---|
| `LLM_API_KEY` (name it whatever — referenced as `secrets.LLM_API_KEY` below) | Their own LLM provider key |

Only if they use Jira ticketing:

| Secret | Notes |
|---|---|
| `JIRA_TOKEN` | Atlassian API token |
| `JIRA_BASE_URL`, `JIRA_PROJECT` | Can be plain repo variables instead of secrets — not sensitive |

Only if they opt into metrics reporting:

| Secret | Notes |
|---|---|
| `METRICS_ENDPOINT` | Supabase edge function URL — see `supabase/README.md` |
| `METRICS_API_KEY` | The function's `METRICS_INGEST_KEY` value |

GitHub Issues ticketing needs **no extra secret** — it uses the workflow's
own automatic `GITHUB_TOKEN`.

## 2. The workflow file

Drop this in as `.github/workflows/pr-review.yml` in their repo. This is
the minimal version (OpenAI-compatible key, inline comments only):

```yaml
name: AI PR Review

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: AbhishikaAgarwal/myco-bundled-action@v1
        with:
          pr_link: ${{ github.event.pull_request.html_url }}
          litellm_api_key: ${{ secrets.LLM_API_KEY }}
```

That's it for the bare minimum — `litellm_base_url` defaults to OpenAI's
own endpoint, `litellm_model` defaults to `gpt-4.1`.

### Variants

Raw Anthropic key instead of an OpenAI-compatible one:

```yaml
        with:
          pr_link: ${{ github.event.pull_request.html_url }}
          llm_provider: anthropic
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Add GitHub Issues ticketing for confirmed bugs (needs `issues: write` too):

```yaml
permissions:
  contents: read
  pull-requests: write
  issues: write

    steps:
      - uses: AbhishikaAgarwal/myco-bundled-action@v1
        with:
          pr_link: ${{ github.event.pull_request.html_url }}
          litellm_api_key: ${{ secrets.LLM_API_KEY }}
          ticket_provider: github-issues
          create_tickets_for: all-confirmed   # or 'merge-blocking' (default) to only ticket blockers
```

Add Jira ticketing instead:

```yaml
        with:
          pr_link: ${{ github.event.pull_request.html_url }}
          litellm_api_key: ${{ secrets.LLM_API_KEY }}
          ticket_provider: jira
          jira_base_url: ${{ vars.JIRA_BASE_URL }}
          jira_token: ${{ secrets.JIRA_TOKEN }}
          jira_project: ${{ vars.JIRA_PROJECT }}
```

Opt into metrics reporting (see `supabase/README.md` for the endpoint/key):

```yaml
        with:
          # ...whatever's above, plus:
          metrics_endpoint: ${{ secrets.METRICS_ENDPOINT }}
          metrics_api_key: ${{ secrets.METRICS_API_KEY }}
```

Full input reference: `myco-bundled-action`'s own `action.yml`/`README.md`.

## 3. What the client should expect

- Inline PR review comments on their next PR (or push to an existing PR
  that matches the `on:` trigger above).
- If `ci_gate` is left at its default (`true`): a confirmed, merge-blocking
  finding (P1+ by default, via `gate_min_severity`) fails the job — this
  can be used as a required check to actually block merges, or left as a
  non-required check if they just want visibility first.
- Optional tickets (Jira or GitHub Issues) if configured.
- Nothing leaves their repo except: the PR diff/code sent to their own
  configured LLM provider, and — only if they opt in — the minimized
  metrics summary (counts + finding titles/severity/verdict; never file
  paths, root cause, fix text, or code) to the metrics endpoint.

## 4. Known limitations to set expectations on

- First run on a repo clones the whole target repo fresh (`TARGET_REPO_PATH`,
  default `./target-repo`) — normal, not a bug, just means the first run on
  a large repo is slower than subsequent ones on the same runner (GitHub
  Actions runners are ephemeral, so in practice this re-clones every run
  unless the workflow adds its own caching — not done by default).
- Findings/output only persist as a GitHub Actions artifact for the
  workflow's configured retention (not yet wired to any durable store —
  see TODO.md "Durable output storage").
- BYO-key path is code-complete and unit-tested at the client level, but
  hasn't yet been run against a live third-party key end-to-end — worth a
  first real run being watched closely rather than assumed silent.
- `LinearTicketCreator` doesn't exist yet — Jira and GitHub Issues only.
