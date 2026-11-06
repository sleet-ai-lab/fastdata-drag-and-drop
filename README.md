# fastdata-drag-and-drop

a preact web app, built with vite. deployed as a static site behind a
cloudflare tunnel.

live at https://fastdata-drag-and-drop.shit-1170.com/

## develop

```sh
bun install
bun dev
```

## build

```sh
bun run build
```

## test

```sh
bun run test
```

## deploy

**run this after every change**, so what you test is what is deployed:

```sh
bun run deploy
```

it runs the tests, rebuilds the image, rolls the stack, and verifies
that the live site serves the bundle the local build produced — so a
stale image cannot pass silently. see
[DOCKER/README.md](./DOCKER/README.md).

services:

| service | container name |
| --- | --- |
| frontend | `fastdata-drag-and-drop-frontend` |
| tunnel | `fastdata-drag-and-drop-cloudflare` |
