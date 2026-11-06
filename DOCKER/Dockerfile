# ========================================
# fastdata-drag-and-drop — Dockerfile
#
# three stages:
#   builder — node:24-alpine, runs `vite build` over src/ into dist/
#   runtime — nginx:alpine, serves the built dist/ as static files
#
# the runtime stage carries ONLY the built site + nginx config. no bun,
# no node, no node_modules, no vite — the final image stays tiny.
#
# the site is a static SPA, so nginx just serves files. there is no
# backend, no database and no persistent state.
# ========================================
# syntax=docker/dockerfile:1.7

# ========================================
# Stage 1: build the static site.
#
# WHY node and not bun: the vite build under `oven/bun:alpine` needs a
# real node runtime for the rollup native bindings to resolve on
# alpine (musl). node:24-alpine carries the matching musl build, so
# `vite build` succeeds without extra apk packages.
#
# node only lives in this stage — the final image is nginx:alpine.
# ========================================
FROM node:24-alpine AS builder

WORKDIR /build

# copy the manifest + lockfile FIRST so the dependency install layer is
# cached independently of source-only edits.
#
# NOTE: the lockfile is gitignored in this repo (see .gitignore), so it
# is usually absent from the build context. `npm install` (not
# `npm ci`) is used because there is nothing to install *from* —
# a lockfile is what `npm ci` requires.
COPY package.json ./
COPY src ./src
COPY index.html ./index.html
COPY vite.config.js ./vite.config.js
COPY public ./public

# --- WHY: `npm install` and not `bun install` ---
# see the stage note above — vite build needs node. the only
# dependencies that matter for the static build are vite and the
# preact preset.
RUN npm install --no-audit --no-fund

# produce the minified static site at /build/dist.
RUN npm run build \
    && rm -rf node_modules/.vite

# ========================================
# Stage 2: minimal runtime image.
# ========================================
FROM nginx:alpine AS runtime

# the site's own nginx config: gzip, sensible caching, and a SPA-style
# fallback so unknown paths still land on the page instead of a 404.
#
# NOTE: this overwrites the stock /etc/nginx/conf.d/default.conf —
# that file IS the stock server block, so copying ours to the same
# path replaces it. there is no second default.conf left behind, so
# nginx does not hit "duplicate server on port 80" at startup.
COPY DOCKER/nginx.conf /etc/nginx/conf.d/default.conf

# the built site, copied in as root (nginx:alpine's default root
# worker only needs READ access).
COPY --from=builder /build/dist /usr/share/nginx/html

# nginx listens on 80 inside the container. binding 0.0.0.0 is what
# makes the container reachable from the other containers on the
# compose network (cloudflared).
EXPOSE 80

# a short-lived healthcheck so compose can report the service as
# healthy before the tunnel starts routing traffic at it.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

# `nginx -g 'daemon off;'` keeps nginx in the foreground so docker can
# supervise it as PID 1. the stock entrypoint is replaced entirely so
# it does not try to run our own scripts.
CMD ["nginx", "-g", "daemon off;"]
# ========================================
