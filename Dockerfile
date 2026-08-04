# syntax=docker/dockerfile:1

# Noctua ships as one image: the Fastify API, the built SPA it serves, and a real Chromium for the
# agent to drive. Two stages, because the toolchain that produces `dist/` has no business being on
# a public host.

# ---------------------------------------------------------------------------------------------
# Stage 1 — build
# ---------------------------------------------------------------------------------------------
FROM node:22-bookworm AS build

# `npm ci` at the root would pull a Chromium down for the `playwright` package's postinstall. This
# stage needs its type declarations and nothing else, and the runtime stage gets its browser from
# the Playwright image — so this skips ~150 MB of download in a layer that is thrown away anyway.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Manifests before sources, in their own layers. Sources change on every commit and lockfiles
# almost never, and the installs are the slow part of this build.
COPY package.json package-lock.json ./
RUN npm ci
COPY web/package.json web/package-lock.json ./web/
RUN npm ci --prefix web

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

# tsc for the server, vite for the SPA. Both outputs are copied out below; nothing else here is.
RUN npm run build

# ---------------------------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------------------------
#
# The tag MUST track the `playwright` version resolved in package-lock.json (1.62.1). Playwright
# refuses to drive a browser build it was not compiled against, and the image is only useful
# because its /ms-playwright Chromium is exactly the one this version expects. Bumping the
# dependency without bumping this line produces an image that builds and then fails on the first
# `chromium.launch()` — so change the two together.
FROM mcr.microsoft.com/playwright:v1.62.1-noble AS runtime

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data
# The browsers are already in the image, at the PLAYWRIGHT_BROWSERS_PATH it sets for itself; the
# postinstall below would otherwise download a second copy of them into the layer.
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Reinstalled from the lockfile rather than copied from the build stage: `sharp` resolves a
# platform-specific binary, and this stage is Ubuntu noble where the one above is Debian bookworm.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# `server.ts` resolves the SPA as `<module dir>/../web/dist`, which from `/app/dist/server.js` is
# `/app/web/dist` — so this layout is load-bearing, not cosmetic.
COPY --from=build /app/dist ./dist
COPY --from=build /app/web/dist ./web/dist

# Runs of record live here: one directory per run, holding events.jsonl and its screenshots. Made
# and owned before the drop to pwuser, because a container that cannot write this cannot start a
# run at all. A bind mount over it inherits the host directory's ownership instead — see deploy.sh,
# which is what makes the mounted directory writable by this uid.
RUN mkdir -p /app/data && chown -R pwuser:pwuser /app/data

# The Playwright image ships this unprivileged user. Chromium is launched with --no-sandbox
# (src/browser/session.ts), which is safe here precisely because the process it runs as is not root.
USER pwuser

EXPOSE 8080

# Open by design: /healthz takes no cookie and reveals nothing about any run. wget ships in the
# Playwright image, so this costs a few milliseconds rather than a second Node process every 30s.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/healthz" || exit 1

# Not `npm start`: that wraps the process in a shell and an npm, which swallows signals and leaves
# `docker stop` waiting out its timeout on every deploy.
CMD ["node", "dist/main.js"]
