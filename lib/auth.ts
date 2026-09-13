/**
 * Auth token verification for the socket server.
 *
 * This is a trimmed copy of the main Next.js app's `src/lib/auth.ts` —
 * only the piece the socket server actually needs (verifying a JWT issued
 * by the main app at login/signup). It intentionally has no dependency on
 * `next/server`, since this process never runs inside Next.
 *
 * Keep `JWT_SECRET` identical to the main app's `.env` — tokens are signed
 * there and verified here, so a mismatched secret makes every socket
 * connection fail auth.
 */
import jwt from "jsonwebtoken";

/** Shape of the data encoded inside every auth token the main app issues. */
export interface AuthTokenPayload {
  /** The authenticated user's id (JWT "subject"). */
  sub: number;
  email: string;
}

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set — add it to your .env file.");
  }
  return secret;
}

/**
 * Verifies a token's signature and expiry.
 * Returns the decoded payload if valid, or `null` if the token is missing,
 * malformed, expired, or signed with a different secret.
 */
export function verifyAuthToken(token: string): AuthTokenPayload | null {
  try {
    return jwt.verify(token, getJwtSecret()) as AuthTokenPayload;
  } catch {
    return null;
  }
}
