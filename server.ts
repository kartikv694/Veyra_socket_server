/**
 * Veyra — standalone Socket.IO signaling server.
 *
 * This used to be `server.ts` inside the `veyra` Next.js project, wrapping
 * `next()` itself so one Node process served both the app and the sockets.
 * That doesn't work in the environment the Next app now runs in — it needs
 * a persistent, long-lived process to keep WebSocket connections open,
 * which that environment doesn't provide, so the combined server failed to
 * build/run there.
 *
 * This file is the same signaling logic, pulled out into its own project
 * so it can be run/deployed anywhere that *does* give it a persistent
 * process (a small VM, Render/Railway/Fly.io, etc.) — completely separate
 * from wherever the Next.js app itself is deployed. See README.md.
 *
 * Because it's no longer in the same process as the Next app's API routes,
 * it can't share an in-memory `io` instance with them anymore. Instead it
 * exposes a small internal HTTP API (`/internal/emit-room`,
 * `/internal/emit-user`) that those route handlers call over HTTP to push
 * events — see the main app's `src/lib/socket-emitters.ts`.
 */
import "dotenv/config";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Server, type Socket } from "socket.io";
import { verifyAuthToken } from "./lib/auth.js";
import { prisma } from "./lib/prisma.js";
import { meetingChannel, userChannel } from "./lib/channels.js";

const port = Number(process.env.PORT ?? 4000);
const SOCKET_PATH = process.env.SOCKET_PATH ?? "/api/socket";
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? "*";
const INTERNAL_SECRET = process.env.INTERNAL_EMIT_SECRET;

if (!INTERNAL_SECRET) {
  throw new Error(
    "INTERNAL_EMIT_SECRET is not set — add it to socket-server/.env, and make sure the " +
      "Next app's SOCKET_SERVER_INTERNAL_SECRET matches it exactly.",
  );
}

/** Data Socket.IO's auth middleware attaches to each verified connection. */
interface SocketData {
  userId: number;
  roomToken: string;
  name: string;
  isHost: boolean;
  isMuted: boolean;
  isCameraOff: boolean;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const httpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.url?.startsWith(SOCKET_PATH)) return; // Socket.IO's own listener handles this.

  // --- Internal API: called only by the Next.js app's REST route handlers
  // (e.g. host mute/remove/end-meeting), never by browsers directly. ---
  if (req.method === "POST" && (req.url === "/internal/emit-room" || req.url === "/internal/emit-user")) {
    if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) {
      res.writeHead(401).end("Unauthorized");
      return;
    }

    readJsonBody(req)
      .then((body) => {
        const { roomToken, userId, event, payload, disconnect } = body as {
          roomToken: string;
          userId?: number;
          event: string;
          payload?: unknown;
          disconnect?: boolean;
        };

        if (!roomToken || !event) {
          res.writeHead(400).end("Missing roomToken or event");
          return;
        }

        const channel =
          req.url === "/internal/emit-user" && userId !== undefined
            ? userChannel(roomToken, userId)
            : meetingChannel(roomToken);

        const deliveredTo = io.sockets.adapter.rooms.get(channel)?.size ?? 0;
        io.to(channel).emit(event, payload);
        if (disconnect) io.in(channel).disconnectSockets(true);

        res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ ok: true, deliveredTo }));
      })
      .catch(() => {
        res.writeHead(400).end("Invalid JSON body");
      });
    return;
  }

  res.writeHead(404).end("Not found");
});

const io = new Server<
  Record<string, unknown>,
  Record<string, unknown>,
  Record<string, never>,
  SocketData
>(httpServer, { path: SOCKET_PATH, cors: { origin: CORS_ORIGIN } });

/**
 * Auth middleware: every connection must present a valid JWT (the same one
 * issued at login/signup by the main app) plus the room token it wants to
 * join, and must already be an active participant of that meeting per the
 * database — matches the access rules already enforced by the REST API, so
 * the socket layer can't be used to bypass them.
 */
io.use(async (socket, next) => {
  const { token, roomToken } = socket.handshake.auth as { token?: string; roomToken?: string };
  if (!token || !roomToken) {
    return next(new Error("Missing token or roomToken"));
  }

  const payload = verifyAuthToken(token);
  if (!payload) {
    return next(new Error("Invalid or expired token"));
  }

  // Everything below can throw (a transient DB hiccup, a dropped
  // connection, etc.) — and Socket.IO does NOT catch exceptions thrown
  // inside an async middleware itself. Left unguarded, that becomes an
  // unhandled promise rejection, and Node kills the *entire process* on
  // an unhandled rejection by default (Node 15+, definitely in the Node
  // 24 this runs on) — not just refuse the one connection. That's the
  // actual cause of "the server was fine, then every connection started
  // failing with ECONNREFUSED": one bad query silently took the whole
  // server down, and it never restarted itself. This try/catch is what
  // makes a real DB/auth problem a normal "connection rejected" instead
  // of a server-ending crash.
  try {
    const participant = await prisma.participants.findFirst({
      where: { userId: payload.sub, leftAt: null, meeting: { token: roomToken } },
      include: { user: { select: { name: true, email: true } } },
    });
    if (!participant) {
      return next(new Error("Not an active participant in this meeting"));
    }

    socket.data.userId = payload.sub;
    socket.data.roomToken = roomToken;
    socket.data.name = participant.user.name ?? participant.user.email;
    socket.data.isHost = participant.isHost;
    socket.data.isMuted = participant.isMuted;
    socket.data.isCameraOff = participant.isCameraOff;
    next();
  } catch (err) {
    console.error("[auth middleware] failed to verify participant:", err);
    next(new Error("Could not verify meeting membership — please try again."));
  }
});

io.on("connection", (socket: Socket<any, any, any, SocketData>) => {
  const { roomToken, userId, name, isHost, isMuted, isCameraOff } = socket.data;
  socket.join(roomToken);
  // Lets the internal HTTP API (e.g. host mutes/removes this user) target
  // this specific person without knowing their live socket id.
  socket.join(userChannel(roomToken, userId));

  // Tell the newcomer who's already in the room, so *they* initiate the
  // WebRTC offer to each existing peer (see src/hooks/useMeetingRoom.ts).
  const roomSocketIds = io.sockets.adapter.rooms.get(roomToken);
  const existingPeers = roomSocketIds
    ? [...roomSocketIds]
        .filter((id) => id !== socket.id)
        .map((id) => {
          const peerSocket = io.sockets.sockets.get(id) as Socket<any, any, any, SocketData> | undefined;
          return peerSocket ? { socketId: id, userId: peerSocket.data.userId, name: peerSocket.data.name, isHost: peerSocket.data.isHost, isMuted: peerSocket.data.isMuted, isCameraOff: peerSocket.data.isCameraOff } : null;
        })
        .filter((p): p is { socketId: string; userId: number; name: string; isHost: boolean; isMuted: boolean; isCameraOff: boolean } => p !== null)
    : [];
  socket.emit("room:peers", existingPeers);

  // Tell everyone already there that someone new has arrived (they'll
  // receive an offer from the newcomer shortly).
  socket.to(roomToken).emit("peer:joined", { socketId: socket.id, userId, name, isHost, isMuted, isCameraOff });

  // --- WebRTC signaling relay: server never inspects SDP/ICE contents, it
  // just forwards between the two socket ids involved. ---
  socket.on("webrtc:offer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    // @ts-ignore
    io.to(to).emit("webrtc:offer", { from: socket.id, fromUserId: userId, name, sdp });
  });

  socket.on("webrtc:answer", ({ to, sdp }: { to: string; sdp: unknown }) => {
    // @ts-ignore
    io.to(to).emit("webrtc:answer", { from: socket.id, sdp });
  });

  socket.on("webrtc:ice-candidate", ({ to, candidate }: { to: string; candidate: unknown }) => {
    // @ts-ignore
    io.to(to).emit("webrtc:ice-candidate", { from: socket.id, candidate });
  });

  // Live mic/camera state — deliberately NOT written to the database. It's
  // ephemeral connection state, not the durable Participant.isMuted field;
  // broadcasting it over the socket is what makes mute icons update in
  // real time without a network round trip per toggle.
  socket.on("peer:media-state", (state: { micOn: boolean; cameraOn: boolean }) => {
    socket.to(roomToken).emit("peer:media-state", { socketId: socket.id, userId, ...state });
  });

  // Raised-hand indicator — same reasoning as media-state: ephemeral,
  // not written to the database.
  socket.on("peer:hand-raised", ({ raised }: { raised: boolean }) => {
    socket.to(roomToken).emit("peer:hand-raised", { socketId: socket.id, userId, raised });
  });

  socket.on("peer:screen-share-state", ({ sharing }: { sharing: boolean }) => {
    socket.to(roomToken).emit("peer:screen-share-state", { socketId: socket.id, sharing });
  });

  // Quick emoji reactions — fire-and-forget, broadcast to the whole room
  // including the sender (so their own click gives the same feedback
  // everyone else sees), never stored anywhere.
  socket.on("peer:reaction", ({ emoji }: { emoji: string }) => {
    io.to(roomToken).emit("peer:reaction", { emoji, userId, name });
  });

  // Chat messages — broadcast to the whole room including the sender
  // (same reasoning as reactions), never stored server-side. A message
  // history that survives a refresh would need a database table and a
  // fetch-on-join endpoint; not built here, so chat is live-only.
  socket.on("peer:chat-message", ({ text }: { text: string }) => {
    const trimmed = typeof text === "string" ? text.trim().slice(0, 2000) : "";
    if (!trimmed) return;
    io.to(roomToken).emit("peer:chat-message", { text: trimmed, userId, name, at: Date.now() });
  });

  socket.on("disconnect", async () => {
    // One user can temporarily have two sockets during a refresh/reconnect.
    // Never mark the DB participant as left while another live socket for the
    // same user is still in this room.
    const roomSocketIds = io.sockets.adapter.rooms.get(roomToken);
    const anotherLiveSocket = roomSocketIds
      ? [...roomSocketIds].some((id) => {
          if (id === socket.id) return false;
          const peerSocket = io.sockets.sockets.get(id) as Socket<any, any, any, SocketData> | undefined;
          return peerSocket?.data.userId === userId;
        })
      : false;

    socket.to(roomToken).emit("peer:left", { socketId: socket.id, userId });
    if (anotherLiveSocket) return;

    try {
      await prisma.participants.updateMany({
        where: { userId, meeting: { token: roomToken }, leftAt: null },
        data: { leftAt: new Date() },
      });
    } catch (err) {
      console.error(`Failed to mark user ${userId} as left in meeting ${roomToken}:`, err);
    }
  });
});

// Explicit "0.0.0.0" (all network interfaces), not just left implicit —
// this is Node's default anyway, but being explicit means the log line
// below always accurately reflects what's actually listening, which
// matters for diagnosing "works on localhost but not from another device
// on the network" (usually a Windows Firewall rule, not this server).
httpServer.listen(port, "0.0.0.0", () => {
  console.log(`> Veyra socket server ready:`);
  console.log(`    - http://localhost:${port}${SOCKET_PATH} (same machine)`);
  console.log(`    - http://<this machine's LAN IP>:${port}${SOCKET_PATH} (other devices)`);
  console.log(
    `  If the LAN address isn't reachable from another device, this process is fine — it's almost` +
      ` always Windows Firewall blocking the port for network (not loopback) connections. Run this` +
      ` in an elevated PowerShell to allow it:`,
  );
  console.log(
    `    New-NetFirewallRule -DisplayName "Veyra Socket Server" -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow`,
  );
});

/**
 * Last line of defense: if some other code path (not just the auth
 * middleware above) throws or rejects without being caught, log it
 * loudly instead of letting Node's default behavior silently kill the
 * process. This is what turns "the server mysteriously stops responding
 * and every client sees ECONNREFUSED" into "check the terminal, there's
 * an error printed right there." It does NOT make the server bulletproof
 * — a genuinely fatal error (e.g. losing the DB connection entirely)
 * should still be visible and may still need a restart — but a single
 * bad request/query no longer has to take the whole thing down.
 */
process.on("unhandledRejection", (reason) => {
  console.error("[unhandled rejection] this would have crashed the server before:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaught exception] this would have crashed the server before:", err);
});
