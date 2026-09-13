-- Performance indexes for the live meeting/dashboard query paths.
CREATE INDEX IF NOT EXISTS "Meeting_hostId_createdAt_idx" ON "Meeting"("hostId", "createdAt");
CREATE INDEX IF NOT EXISTS "Meeting_scheduledAt_idx" ON "Meeting"("scheduledAt");
CREATE INDEX IF NOT EXISTS "Participants_userId_leftAt_idx" ON "Participants"("userId", "leftAt");
CREATE INDEX IF NOT EXISTS "Participants_meetingId_leftAt_idx" ON "Participants"("meetingId", "leftAt");
CREATE INDEX IF NOT EXISTS "JoinRequest_meetingId_status_idx" ON "JoinRequest"("meetingId", "status");
