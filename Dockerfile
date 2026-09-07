# ─────────────────────────────────────────────────────────────
# Trustpilot Lead Gen — Cloud Run container
# Includes: Node 20 (API) + Python 3.11 + Playwright Chromium
# ─────────────────────────────────────────────────────────────

# Debian 12. Was bullseye, moved 2026-09-07: bullseye-security had dropped
# python3-setuptools 52.0.0-4+deb11u2 from its pool while still listing it in
# the index, so every build 404'd on it, and bullseye is past end of life.
FROM node:20-bookworm-slim

# ── System deps: Python + Chromium runtime libraries ──────────
# deb.debian.org is a Fastly CDN and its index and pool edges can fall out of
# step: `apt-get update` fetches an index naming a .deb that another edge has
# already dropped, and the install 404s. That is what broke this build on
# 2026-09-07 (python3-setuptools 52.0.0-4+deb11u2, superseded by a security
# update after the 09-03 build). No-Cache forces a revalidated index so the
# two agree, and Retries rides out a mid-sync mirror.
RUN apt-get -o Acquire::Retries=5 -o Acquire::http::No-Cache=true update \
 && apt-get install -y --no-install-recommends -o Acquire::Retries=5 \
    python3 \
    python3-pip \
    # Chromium system libraries required by Playwright
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    libpangocairo-1.0-0 \
    libpango-1.0-0 \
    libcairo2 \
    libfontconfig1 \
    libfreetype6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ── Python: install packages + Playwright browser ─────────────
COPY requirements.txt ./
# PEP 668: bookworm marks the system Python as externally managed and refuses
# a plain pip install. This container IS the environment, so opt out rather
# than add a venv indirection the rest of the image would have to know about.
RUN pip3 install --no-cache-dir --break-system-packages -r requirements.txt && \
    python3 -m playwright install chromium

# ── Node: install dependencies + Playwright Chromium ──────────
COPY server/package*.json ./server/
RUN cd server && npm ci && npx playwright install chromium

# ── Node: copy source + compile TypeScript ────────────────────
COPY server/ ./server/
RUN cd server && npm run build

# Remove dev dependencies to slim the image
RUN cd server && npm prune --production

# ── Python tools (scrapers + DB utils) ───────────────────────
COPY tools/ ./tools/

# ── Runtime environment ───────────────────────────────────────
ENV NODE_ENV=production
ENV PORT=8080
ENV PYTHON_PATH=/usr/bin/python3
ENV PLAYWRIGHT_HEADLESS=true
ENV PYTHONUNBUFFERED=1
ENV EMAIL_MODE=mock

# Cloud Run listens on 8080 by default
EXPOSE 8080

# Start the compiled API server
CMD ["node", "server/dist/server.js"]
