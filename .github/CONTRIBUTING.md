# Contributing to Optinet Solutions AI Projects

Thank you for contributing. Follow these rules to keep the codebase clean and consistent.

---

## Branching

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready code only |
| `dev` | Integration branch — all PRs target this |
| `feat/<name>` | New features |
| `fix/<name>` | Bug fixes |
| `chore/<name>` | Maintenance, deps, config |

Never commit directly to `main`. Always branch from `dev`.

---

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <short description>

[optional body]
```

**Types:** `feat` | `fix` | `chore` | `docs` | `refactor` | `test` | `style`

**Examples:**
```
feat(scraper): add parallel 3-tab website enrichment
fix(api): resolve Python path on Linux Cloud Run
chore(deps): upgrade playwright to 1.42
docs(api): update campaign endpoint reference
```

Keep the subject line under 72 characters.

---

## Pull Requests

- Target `dev` branch (never `main` directly)
- Fill in the PR template completely
- Link any related issue: `Closes #123`
- One logical change per PR — don't bundle unrelated fixes
- All TypeScript must pass `tsc --noEmit` before requesting review
- Screenshots required for any UI changes

---

## Code Standards

### TypeScript (API + Frontend)
- Strict mode enabled — no `any` without a comment explaining why
- No hardcoded credentials, URLs, or environment-specific values
- Use `const` over `let` wherever possible
- API routes always return `{ success: true, data }` or `{ success: false, error }`

### Python (Scrapers)
- One script = one responsibility
- All async scraping uses `asyncio` + Playwright
- Always include retry logic (max 3 attempts) for network calls
- Log every run with timestamp and result count
- 2–5s randomized delays between Trustpilot requests (rate limit avoidance)

### React (Frontend)
- Frontend is **dumb** — zero business logic, display + API calls only
- All data fetching goes through custom hooks (`useLeads`, `useCampaigns`, etc.)
- Never call `fetch()` or `axios` directly from a component
- Always handle `loading`, `error`, and empty states
- Use Tailwind utility classes only — no inline styles, no CSS modules

---

## Environment & Secrets

- All secrets live in `.env` (gitignored) — never commit credentials
- In production, secrets are injected via Cloud Run environment variables
- Never log API keys, tokens, or passwords to console
- `.env.example` must stay up to date with every new variable added

---

## What NOT to Do

- Don't break the Supabase schema without a migration file
- Don't change API response shapes — frontend depends on exact structure
- Don't change the lead `outreach_status` enum values
- Don't add features beyond what was asked — no speculative abstractions
- Don't skip `playwright install chromium` when adding new scraper tests
