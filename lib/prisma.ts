/**
 * Prisma client singleton for the socket server process.
 *
 * This is a copy of the main app's `src/lib/prisma.ts`, pointed at this
 * project's own copy of the generated client (`../generated/prisma`) since
 * this process can't reach into the Next.js app's `src/` folder.
 *
 * IMPORTANT: if you change `prisma/schema.prisma` in the main `veyra`
 * project, re-run `npx prisma generate` there and copy the resulting
 * `src/generated/prisma` folder over `socket-server/generated/prisma` again
 * — the two must stay in sync since they read the same database.
 */
import { PrismaClient } from "../src/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  return new PrismaClient({ adapter });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
