# Coolify-ready Dockerfile for mcp-officecli-bridge
# - Node 20 + OfficeCLI binary (self-contained, no .NET needed)
# - Stateless stdio → Streamable HTTP bridge

FROM node:20-slim

# Needed to download OfficeCLI binary + healthcheck + .NET ICU dependency
# OfficeCLI is a .NET binary and requires libicu on slim images.
# Use libicu-dev (metapackage) so it works on bookworm (72) and trixie (76) without hardcoding version.
# Also install libicu72/libicu76 explicitly as fallback for slim variants where -dev is trimmed.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates libicu-dev 2>/dev/null || true; \
    apt-get install -y --no-install-recommends libicu72 2>/dev/null || apt-get install -y --no-install-recommends libicu76 2>/dev/null || true; \
    rm -rf /var/lib/apt/lists/*; \
    dpkg -l | grep -i icu || echo "libicu not found — will fallback to Invariant mode at runtime"

# Install OfficeCLI binary (Linux x64). Pin version via OFFICECLI_VERSION if you want reproducibility.
ARG OFFICECLI_VERSION=latest
ARG TARGETARCH
# TARGETARCH is amd64/arm64 from docker buildx
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
    echo "--- officecli version check (normal) ---"; \
    /usr/local/bin/officecli --version 2>&1 && echo "OK with libicu" || \
    (echo "--- libicu missing, testing Invariant fallback ---"; DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 /usr/local/bin/officecli --version 2>&1 && echo "OK with Invariant=1 (no globalization)")

# Runtime globalization: false = with ICU (full), true = without ICU (fallback).
# We default to false because libicu is installed; if libicu is missing at runtime, OfficeCLI still runs with Invariant=1.
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=false

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev 2>/dev/null || npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime env
ENV NODE_ENV=production
ENV PORT=3000
ENV OFFICECLI_BIN=/usr/local/bin/officecli
# Optional: protect /mcp with Bearer token -> set MCP_AUTH_TOKEN
# ENV MCP_AUTH_TOKEN=your-secret

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://localhost:3000/health | grep -q '"status":"ok"' || exit 1

CMD ["node", "dist/server.js"]
