-- AlterTable
ALTER TABLE "Test" ADD COLUMN     "ownerUserId" UUID;

-- CreateIndex
CREATE INDEX "Test_ownerUserId_idx" ON "Test"("ownerUserId");


-- One notification per (student, dedupe key): jobs that run twice (or on two servers) cannot notify twice.
CREATE UNIQUE INDEX "Notification_user_dedupe" ON "Notification" ("userId", (("data"->>'dedupeKey'))) WHERE ("data" ? 'dedupeKey');
