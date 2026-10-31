# FOSSBilling Next.js server (R6c) — the TypeScript deployment.
# The PHP deployment definition lived in the repo-root Dockerfile and
# was deleted with fork src/ in R6c; R6d builds the PHP rollback
# artifact from the PARENT commit (see docs/nextjs-strangler/phase5/
# findings-r6c.md §6). This file deploys the Next app only.
#
# Build:  docker build -t fossbilling-next .
# Run:    docker run -p 3000:3000 \
#           -e FB_DATABASE_PATH=/data/fossbilling.sqlite \
#           -e FB_PUBLIC_URL=https://billing.example.com/ \
#           -e FB_CALLBACK_SALT=<random-hex> \
#           -e APP_ENV=prod \
#           -v fossbilling-data:/data fossbilling-next
#
# Environment (see also vendor/README.md for the vendored data files
# this image carries — GeoIP DBs, email templates, Page/plugin
# templates, content.sql — so no PHP tree is needed at runtime):
#   FB_DATABASE_PATH  SQLite file (default: /data/fossbilling.sqlite)
#     or FB_DATABASE_URL for Postgres (see db.ts for the URL form).
#   FB_PUBLIC_URL     Public base URL of THIS server. REQUIRED for
#     correct links unless config url already names this server
#     (unset = PHP-faithful SYSTEM_URL fallback, i.e. the config
#     url — deployment must set one or the other).
#   FB_GEOIP_DB_DIR   Override for the GeoIP database dir (default:
#     the vendored vendor/geoip inside the image). A set-but-missing
#     dir errors loudly instead of falling back.
#   FB_CALLBACK_SALT  Secret salt for license callbacks. REQUIRED.
#   FB_CONFIG_PATH    Override for config.php location (default:
#     standard install-root layout relative to FB_DATABASE_PATH).
#   APP_ENV=prod      REQUIRED in production: without APP_ENV=prod
#     (or FB_RATE_LIMIT_ENFORCE=1) the rate limiter does not enforce.
#   TZ                Timezone for date rendering (default UTC).
#   FB_TS_MODULES     Enabled modules (default: the full set; the
#     reference deployment enables all 35 incl. theme).

FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd -r fossbilling && useradd -r -g fossbilling fossbilling \
  && mkdir -p /data && chown fossbilling:fossbilling /data
USER fossbilling
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY package.json next.config.ts ./
COPY vendor ./vendor
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
