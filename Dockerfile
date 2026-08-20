# Coolify-ready Dockerfile for mcp-officecli-bridge
# - Node 20 + OfficeCLI binary (self-contained, no .NET needed)
# - Stateless stdio → Streamable HTTP bridge

FROM node:20-slim

# Needed to download OfficeCLI binary + healthcheck
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates && rm -rf /var/lib/apt/lists/*

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
    /usr/local/bin/officecli --version || (echo "officecli binary check failed" && exit 1)

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
