# Myco — PR Review Setup Guide

Myco reviews your pull requests automatically: inline comments on bugs, regressions, and test-coverage gaps, plus a check that the code actually does what the PR description says it's supposed to do. It runs inside your own CI, using your own LLM API key. Your code is sent only to the LLM provider you configure — we never see it, and you never see or need access to our source.

Setup takes about 5 minutes.

## What you'll need

- A GitHub repo with Actions enabled.
- An API key for an LLM provider — OpenAI, Anthropic, or any OpenAI-compatible endpoint (Together, Groq, a LiteLLM proxy, etc.).

## Step 1 — Accept the collaborator invite

We'll invite your GitHub account (or org) as a collaborator on our private action repo. Accept the invite from GitHub — your CI needs this to pull the action. You won't get or need access to our actual source code, just the ability to reference it in your workflow.

## Step 2 — Add the workflow file

Create `.github/workflows/pr-review.yml` in your repo with this content:

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

This is the whole setup for a standard OpenAI-compatible key — it defaults to `gpt-4.1` against OpenAI's own endpoint.

## Step 3 — Add your API key as a secret

In your repo: **Settings → Secrets and variables → Actions → New repository secret.**

Name it `LLM_API_KEY` and paste your key as the value. Nothing else to set for a plain OpenAI key.

**Using a different OpenAI-compatible provider?** Add two more inputs to the step above:

```yaml
          litellm_base_url: https://your-provider-endpoint.com/v1
          litellm_model: your-model-name
```

**Using a native Anthropic key instead?** Swap the key input for these:

```yaml
          llm_provider: anthropic
          anthropic_api_key: ${{ secrets.ANTHROPIC_API_KEY }}
```

(A raw Gemini key doesn't need this — Gemini has its own OpenAI-compatible endpoint, so the default setup above already works with it via `litellm_base_url`.)

## Step 4 — Open a pull request

That's it. Myco reviews the PR automatically and posts inline comments on anything it finds. No manual step per PR — it triggers on every PR open, push, and reopen that matches the `on:` block above.

## How it works

Before writing a review, Myco reads the PR description as the stated intent for the change, and — if the description contains links — tries to fetch them for additional context. It then checks whether the diff actually matches what was described, and flags any mismatch as its own finding (labeled "Intent mismatch"), right alongside the usual bug and coverage findings.

Worth knowing: links to tools like Notion, Linear, Jira, or Confluence usually can't be read this way, since those require login or render their content client-side — Myco will note a link as "referenced but unread" rather than guessing at it. Fully open, plain-text/markdown links, and a description that states the intent directly, work best.

If you'd rather Myco not make outbound requests to links in PR descriptions at all, add:

```yaml
          follow_intent_links: false
```

## Optional: tickets for confirmed bugs

**File a GitHub Issue per confirmed bug** (needs `issues: write` added to `permissions:` too):

```yaml
          ticket_provider: github-issues
          create_tickets_for: all-confirmed   # or 'merge-blocking' to only ticket blockers
```

**File to Jira instead:**

```yaml
          ticket_provider: jira
          jira_base_url: https://yourteam.atlassian.net
          jira_token: ${{ secrets.JIRA_TOKEN }}
          jira_project: YOUR_PROJECT_KEY
```

## What to expect

- Inline PR comments on your next PR (or your next push to an open one).
- By default, a confirmed, merge-blocking finding (severity P1 or above) fails the CI check — set this as a required check if you want it to actually block merges, or leave it as informational if you just want visibility first. Control this with `ci_gate: false` if you'd rather it never block anything.
- Nothing about your code leaves your infrastructure except: the diff sent to whichever LLM provider you configured, and any outbound fetches to links found in PR descriptions (see "How it works" above — disable with `follow_intent_links: false` if that's a concern).

## Good to know

- The first run on a repo is slower than later ones — it needs to clone your repo fresh. This is expected, not a bug.
- Review output is visible in the PR comments; the full output is also attached to the GitHub Actions run itself for 30 days.
- Ticket creation (GitHub Issues / Jira) is mocked and logic-tested on our end but hasn't yet run against a live instance in production — flag anything that looks off on your first ticket and we'll fix it fast.

## Questions?

Reach out to whoever sent you this guide.
