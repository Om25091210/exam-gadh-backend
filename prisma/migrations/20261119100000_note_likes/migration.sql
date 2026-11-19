-- CreateTable
CREATE TABLE "NoteLike" (
    "userId" UUID NOT NULL,
    "noteId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NoteLike_pkey" PRIMARY KEY ("userId","noteId")
);

-- CreateIndex
CREATE INDEX "NoteLike_noteId_idx" ON "NoteLike"("noteId");

-- AddForeignKey
ALTER TABLE "NoteLike" ADD CONSTRAINT "NoteLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NoteLike" ADD CONSTRAINT "NoteLike_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "Note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

