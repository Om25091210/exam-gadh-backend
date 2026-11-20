-- CreateEnum
CREATE TYPE "BattleStatus" AS ENUM ('live', 'finished', 'cancelled');

-- CreateTable
CREATE TABLE "Battle" (
    "id" UUID NOT NULL,
    "status" "BattleStatus" NOT NULL DEFAULT 'live',
    "mode" TEXT NOT NULL,
    "topicCode" TEXT,
    "questionIds" TEXT[],
    "roundMs" INTEGER NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "Battle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BattlePlayer" (
    "id" UUID NOT NULL,
    "battleId" UUID NOT NULL,
    "userId" UUID,
    "isBot" BOOLEAN NOT NULL DEFAULT false,
    "displayName" TEXT NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "totalTimeMs" INTEGER NOT NULL DEFAULT 0,
    "answers" JSONB NOT NULL DEFAULT '[]',
    "result" TEXT,
    "pointsDelta" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BattlePlayer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BattleRating" (
    "userId" UUID NOT NULL,
    "points" INTEGER NOT NULL DEFAULT 0,
    "played" INTEGER NOT NULL DEFAULT 0,
    "wins" INTEGER NOT NULL DEFAULT 0,
    "losses" INTEGER NOT NULL DEFAULT 0,
    "draws" INTEGER NOT NULL DEFAULT 0,
    "bestStreak" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BattleRating_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE INDEX "Battle_finishedAt_idx" ON "Battle"("finishedAt");

-- CreateIndex
CREATE INDEX "BattlePlayer_userId_battleId_idx" ON "BattlePlayer"("userId", "battleId");

-- CreateIndex
CREATE INDEX "BattlePlayer_battleId_idx" ON "BattlePlayer"("battleId");

-- CreateIndex
CREATE INDEX "BattleRating_points_idx" ON "BattleRating"("points");

-- AddForeignKey
ALTER TABLE "BattlePlayer" ADD CONSTRAINT "BattlePlayer_battleId_fkey" FOREIGN KEY ("battleId") REFERENCES "Battle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BattlePlayer" ADD CONSTRAINT "BattlePlayer_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BattleRating" ADD CONSTRAINT "BattleRating_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

