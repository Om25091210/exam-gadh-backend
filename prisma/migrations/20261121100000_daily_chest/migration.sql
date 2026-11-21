-- CreateTable
CREATE TABLE "DailyChest" (
    "userId" UUID NOT NULL,
    "day" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DailyChest_pkey" PRIMARY KEY ("userId","day")
);

-- AddForeignKey
ALTER TABLE "DailyChest" ADD CONSTRAINT "DailyChest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

