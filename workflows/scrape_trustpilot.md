# Workflow: Scrape Trustpilot

## Objective
Scrape all companies from a given Trustpilot category + country filtered by star rating, then deep-scrape each profile for contact details.

## Inputs
| Input | Example | Required |
|-------|---------|----------|
| `country` | `US`, `GB`, `AU` | Yes |
| `category` | `casino`, `online_gambling` | Yes |
| `max_rating` | `3.5` | Yes |
| `min_rating` | `1.0` | No (default: 1.0) |
| `enrich` | `true` | No (default: false) |
| `verify` | `true` | No (default: false) |

## Steps

1. **Run category scraper**
   ```bash
   python tools/scraper/scrape_category.py \
     --country US --category casino \
     --min-rating 1.0 --max-rating 3.5 \
     --output .tmp/raw_scrape_results.json
   ```

2. **Run profile scraper** on each result
   ```bash
   python tools/scraper/scrape_profile.py \
     --input .tmp/raw_scrape_results.json \
     --output .tmp/enriched_leads.json
   ```

3. **[Optional] Run website enrichment**
   ```bash
   python tools/scraper/scrape_website.py \
     --input .tmp/enriched_leads.json \
     --output .tmp/enriched_leads.json
   ```

4. **[Optional] Run email verification**
   ```bash
   python tools/email/verify_email.py \
     --input .tmp/enriched_leads.json \
     --output .tmp/verified_leads.json
   ```

5. **Save to Supabase**
   ```bash
   python tools/db/upsert_leads.py \
     --input .tmp/verified_leads.json
   ```

## Expected Output
- Leads saved to Supabase `leads` table
- Each lead has: company_name, website_url, email(s), phone, rating, status

## Error Handling
- 403 from Trustpilot → increase delay, retry after 30s
- Missing email on profile → leave `trustpilot_email` null, still save lead
- Website unreachable during enrichment → leave `website_email` null, continue
- ZeroBounce API error → leave `email_verified` false, continue
