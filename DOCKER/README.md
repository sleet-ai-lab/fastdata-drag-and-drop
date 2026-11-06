# ========================================
# DOCKER — fastdata-drag-and-drop
#
# two services in one compose stack:
#
#   fastdata-drag-and-drop-frontend   the vite build served by nginx
#   fastdata-drag-and-drop-cloudflare the cloudflare tunnel in front
#
# both live on one compose network, so cloudflared reaches the
# frontend by container name over the internal DNS.
# ========================================

## run it

```sh
# from the repo root
docker compose -f DOCKER/docker-compose.yml up -d --build
docker compose -f DOCKER/docker-compose.yml logs -f
docker compose -f DOCKER/docker-compose.yml down
```

## the tunnel token

the token lives in the repo-root `.env` (gitignored, never committed).
the tracked template is `.env.example`. to set it up:

```sh
cp .env.example .env
# then paste your tunnel token into TUNNEL_TOKEN= in .env
```

the variable MUST be named `TUNNEL_TOKEN` — that is the name
cloudflared itself reads from the environment, and the compose file
hands `.env` to the container verbatim via `env_file`.

**why not `--token ${TUNNEL_TOKEN}` in the command?** compose only
auto-loads a `.env` sitting next to the compose file (in `DOCKER/`),
and `${...}` is interpolated when compose parses the file — before the
service's `env_file` is read. the result is an EMPTY token and a
cloudflared container that just prints its own help text.

## service addresses (for the cloudflare dashboard)

when you add a public hostname route in the cloudflare dashboard, set
the **Service URL** to:

| what | service url |
| --- | --- |
| the site | `http://fastdata-drag-and-drop-frontend:80` |
| the tunnel container | `http://fastdata-drag-and-drop-cloudflare:80` |

use the **frontend** address for the route that serves the site. the
tunnel container address is what the tunnel itself is reachable at
inside the compose network — it is not the origin for the app.

**NOT localhost** — cloudflared is a separate container and has its
own loopback that nothing else is listening on. the container name
resolves over the compose network's internal DNS.

the scheme is `http`: the browser's hop to cloudflare's edge is
https (terminated at the edge), but the edge-to-origin hop runs inside
the compose network, where plain http is fine.

## local debugging

nothing is published to the host on purpose. to reach the site
directly, uncomment the `ports:` block on
`fastdata-drag-and-drop-frontend` in `docker-compose.yml`:

```yaml
    ports:
      - "8080:80"
```

then `http://localhost:8080`.

## no persistent state

the vite build is baked into the image and nginx serves it as static
files. no database, no volume, nothing to migrate. `docker compose
down` loses nothing.

## the image

two stages:

- **builder** — `oven/bun:1-alpine`, runs `vite build` into `dist/`
- **runtime** — `nginx:alpine`, serves the built `dist/`

the runtime image carries only the built site + nginx config. no bun,
no node, no node_modules, no vite.

the builder installs from the tracked `bun.lock` with
`bun install --frozen-lockfile`, so the image always contains exactly
the committed dependency tree. if `package.json` and `bun.lock` ever
disagree, the build fails loudly instead of silently resolving
something else.
