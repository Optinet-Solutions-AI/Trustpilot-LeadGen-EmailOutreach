# Security Policy

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately to: security@optinetsolutions.com

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact
- Suggested fix (optional)

We will respond within 48 hours and aim to patch within 7 days.

---

## Security Rules for This Project

### Credentials
- All secrets in `.env` — never committed to git
- Production secrets injected via Google Cloud Run environment variables
- Service role keys never exposed to the frontend
- `VITE_` prefixed variables are public — never put secrets there

### API
- `API_SECRET_KEY` required in production (set in Cloud Run env vars)
- All scraping done server-side — Trustpilot never called from frontend
- Supabase service role key only used in API/Python layer

### Scraper
- No user input passed directly to shell commands
- Python scripts receive validated params from API only
- `child_process.spawn()` used (not `exec`) to prevent command injection

### Database
- Row Level Security available on Supabase (use if exposing Supabase URL to frontend)
- Currently using service role key (bypasses RLS) — keep it server-side only
