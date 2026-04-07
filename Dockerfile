# ─────────────────────────────────────────────────────────────
# Trustpilot Lead Gen — Cloud Run container
# Includes: Node 20 (API) + Python 3.11 + Playwright Chromium
# ─────────────────────────────────────────────────────────────

FROM node:20-bullseye-slim

# ── System deps: Python + Chromium runtime libraries ──────────
RUN apt-get update && apt-get install -y --no-install-recommends \
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
RUN pip3 install --no-cache-dir -r requirements.txt && \
    python3 -m playwright install chromium

# ── Node: install dependencies ────────────────────────────────
COPY server/package*.json ./server/
RUN cd server && npm ci

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
ENV EMAIL_MODE=mock

# Cloud Run listens on 8080 by default
EXPOSE 8080

# Start the compiled API server
CMD ["node", "server/dist/server.js"]
