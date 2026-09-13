-- AlterTable
ALTER TABLE "Meeting" ADD COLUMN "locked" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Meeting" ADD COLUMN "passcode" TEXT;
