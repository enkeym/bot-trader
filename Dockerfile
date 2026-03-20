# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY prisma ./prisma
COPY . .
RUN npx prisma generate && npm run build

FROM node:20-alpine AS runner
RUN apk add --no-cache libc6-compat openssl
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm install prisma@5.22.0 --no-save
COPY --from=builder /app/prisma ./prisma
# Generate query engine for this image (Alpine + OpenSSL 3); avoids stale .prisma from builder cache.
ENV DATABASE_URL="postgresql://prisma:prisma@127.0.0.1:5432/prisma"
RUN npx prisma generate
COPY --from=builder /app/dist ./dist
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/main.js"]
