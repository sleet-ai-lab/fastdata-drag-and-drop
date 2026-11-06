# fastdata-drag-and-drop

a preact web app, built with vite. deployed as a static site behind a
cloudflare tunnel.

## develop

```sh
bun install
bun dev
```

## build

```sh
bun run build
```

## deploy

the app is served as static files by nginx in docker, fronted by a
cloudflare tunnel. see [DOCKER/README.md](./DOCKER/README.md) for the
compose commands, the tunnel token setup and the service addresses.

```sh
docker compose -f DOCKER/docker-compose.yml up -d --build
```

services:

| service | container name |
| --- | --- |
| frontend | `fastdata-drag-and-drop-frontend` |
| tunnel | `fastdata-drag-and-drop-cloudflare` |
