/**
 * Room-naming helpers. Copy of the naming scheme from the main app's
 * `src/lib/socket-emitters.ts` — kept identical on both sides so the two
 * processes can't drift on how rooms are named.
 */

/** The room every socket in a given meeting joins — just the room token itself. */
export function meetingChannel(roomToken: string): string {
  return roomToken;
}

/** The room a specific user's socket(s) join within a specific meeting. */
export function userChannel(roomToken: string, userId: number): string {
  return `user:${roomToken}:${userId}`;
}
