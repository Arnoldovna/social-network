# social-network

A small social network: register, keep a profile with an avatar, find people, make friends, write on each other's
walls, chat in real time and see who is online. A rebuild of my 2018 project as a pnpm monorepo with a React 19 web
app, an Express 5 API with Socket.IO, and a shared Zod contract.

> This README is a stub. It is completed in the presentation phase (screenshots, architecture, what changed since
> 2018).

## Getting started

Requirements: Node.js 26 (`.nvmrc`), pnpm 10.34.9 (`packageManager`), Docker with Compose 2.24.4 or later.

Reviewer path (seeded production images on `http://127.0.0.1:8080`):

```bash
pnpm install
pnpm demo
```

Developer path (API on :3000, Vite on :5173):

```bash
pnpm install
pnpm dev:setup
pnpm dev
```

`pnpm verify` runs every check CI runs. Architecture and decisions live in [`docs/architecture`](docs/architecture).

## Licence

[MIT](LICENSE). Schibsted Grotesk is licensed under the SIL Open Font License 1.1
([`LICENSES/OFL-SchibstedGrotesk.txt`](LICENSES/OFL-SchibstedGrotesk.txt)).
