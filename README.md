# veyra-socket-server

The Socket.IO signaling server for Veyra, pulled out of the `veyra` Next.js
project into its own standalone project.

## Why this is a separate project

`server.ts` used to live inside `veyra/` and wrap the Next.js app itself,
because Socket.IO needs one long-lived HTTP server it can keep WebSocket
connections open on. The environment the `veyra` app is deployed to doesn't
give it that kind of persistent process, so bundling the two together broke
the build there. This folder is the same signaling logic, deployable on its
own to anywhere that *does* provide a persistent process (a small VM,
Render, Railway, Fly.io, etc.) — completely independent of wherever the
Next.js app is hosted.

It intentionally sits **outside** the `veyra/` folder, as a sibling, not a
subfolder — that's what keeps it out of the Next app's build entirely.

## Setup

```bash
cd socket-server
npm install
cp .env.example .env   # fill in DATABASE_URL, JWT_SECRET, INTERNAL_EMIT_SECRET
npm run dev
```

`JWT_SECRET` and `INTERNAL_EMIT_SECRET` must match the corresponding values
in the main `veyra` app's `.env` exactly — see that project's `.env` for
`SOCKET_SERVER_INTERNAL_SECRET`.

If you change `veyra/prisma/schema.prisma`, regenerate the client there
(`npx prisma generate`) and copy `veyra/src/generated/prisma` over this
project's `generated/prisma` again — both processes read the same database
through their own copy of the generated client.

## How it talks to the main app

- **Browser → this server, directly**: the room page's WebRTC/socket hook
  connects straight to this server's URL (see `NEXT_PUBLIC_SOCKET_URL` in
  the main app's `.env`), not through the Next.js app.
- **Main app → this server**: REST route handlers that need to push a
  real-time event (host mutes/removes someone, ends the meeting) can no
  longer reach an in-process `io` instance, since they now run in a
  different process entirely. Instead they call this server's small
  internal HTTP API:
  - `POST /internal/emit-room` `{ roomToken, event, payload? }`
  - `POST /internal/emit-user` `{ roomToken, userId, event, payload?, disconnect? }`

  Both require an `x-internal-secret` header matching `INTERNAL_EMIT_SECRET`.
  See `veyra/src/lib/socket-emitters.ts` for the calling side.

## Deploying

Deploy this folder as its own Node service (`npm install && npm start`),
separately from the Next.js app. Point:
- the main app's `SOCKET_SERVER_URL` at this service's internal/base URL,
- the main app's `NEXT_PUBLIC_SOCKET_URL` at this service's public URL,
- this service's `CORS_ORIGIN` at the main app's public URL.
