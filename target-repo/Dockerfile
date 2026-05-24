# 1. Common args for remote caching (optional)
ARG TURBO_API
ARG TURBO_TOKEN
ARG TURBO_TEAM

# 2. Base image, for both build & runtime
FROM motorqcustomer.azurecr.io/node:22.14.0-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat

# 3. Builder stage: install deps & build
FROM base AS builder
WORKDIR /app
ARG NPM_GITHUB_TOKEN

# leverage cache for deps
COPY . .
RUN npm ci --pulsar_binary_host_mirror=https://motorqapachemirror.blob.core.windows.net/pulsar-client-node \
  && npm install -g turbo \
  && npm install -g tsoa@5.1.1

COPY . .
RUN turbo run build

# 4. Release stage: ship only dist + prod deps
FROM motorqcustomer.azurecr.io/node:22.14.0-alpine AS release
WORKDIR /app
RUN apk add --no-cache libc6-compat

# copy built apps (includes apps/*/dist)
COPY --from=builder /app/apps ./apps
COPY --from=builder /app/packages ./packages
COPY --from=builder /app/kv-loader.cjs ./
COPY --from=builder /app/run.cjs ./

# install production-only node_modules
COPY --from=builder /app/node_modules ./node_modules
#RUN npm prune --production

# strip out source & integration-test folders
RUN find apps -type d \( -name src -o -name __integrationtest__ \) -prune -exec rm -rf {} +
RUN find packages -type d \( -name src -o -name __integrationtest__ \) -prune -exec rm -rf {} +

# drop to non-root user
RUN addgroup -g 1001 -S nodejs \
  && adduser -S nodejs -u 1001 nodejs \
  && chown -R nodejs:nodejs /app
USER nodejs

# override with your actual start command as needed
CMD ["sleep", "infinity"]
