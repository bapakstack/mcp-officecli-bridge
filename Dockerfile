# Coolify-ready Dockerfile for mcp-officecli-bridge
# - Node 20 + OfficeCLI binary (.NET) — handles libicu robustly
# - Build never fails on version check; runtime falls back to Invariant if needed

FROM node:20-slim

ENV DEBIAN_FRONTEND=noninteractive
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

# Install curl/ca-certificates + libicu (bookworm=72, trixie=76) — try 72 first, then -dev, then skip
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*
RUN apt-get update && (apt-get install -y --no-install-recommends libicu72 && echo "libicu72 installed") || (apt-get install -y --no-install-recommends libicu-dev && echo "libicu-dev installed") || echo "WARN: libicu not installed — will use DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 at runtime"
RUN rm -rf /var/lib/apt/lists/*; dpkg -l | grep -i icu || echo "No libicu package found — Invariant fallback will be used"

# Install OfficeCLI binary
ARG OFFICECLI_VERSION=latest
ARG TARGETARCH
RUN set -eux; \
    ARCH="${TARGETARCH:-amd64}"; \
    if [ "$ARCH" = "arm64" ]; then OFFICECLI_ASSET="officecli-linux-arm64"; else OFFICECLI_ASSET="officecli-linux-x64"; fi; \
    if [ "$OFFICECLI_VERSION" = "latest" ]; then \
      URL="https://github.com/iOfficeAI/OfficeCLI/releases/latest/download/${OFFICECLI_ASSET}"; \
    else \
      URL="https://github.com/iOfficeAI/OfficeCLI/releases/download/${OFFICECLI_VERSION}/${OFFICECLI_ASSET}"; \
    fi; \
    echo "Downloading $URL"; \
    curl -fsSL "$URL" -o /usr/local/bin/officecli; \
    chmod +x /usr/local/bin/officecli; \
    echo "--- officecli version check ---"; \
    /usr/local/bin/officecli --version 2>&1 && echo "OK with ICU" || \
    (echo "No ICU — trying Invariant mode"; DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 /usr/local/bin/officecli --version 2>&1 && echo "OK with Invariant=1") || \
    echo "WARN: officecli version check failed, but continuing build — runtime will retry with Invariant"

WORKDIR /app

COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
# Need dev deps for tsc build; prune after build to keep image small
RUN npm ci || npm install
RUN npm run build
RUN npm prune --omit=dev || npm install --omit=dev

ENV NODE_ENV=production
ENV PORT=3000
ENV OFFICECLI_BIN=/usr/local/bin/officecli

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "dist/server.js"]
