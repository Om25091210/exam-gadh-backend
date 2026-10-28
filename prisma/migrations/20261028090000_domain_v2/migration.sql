-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'suspended');

-- CreateEnum
CREATE TYPE "QuestionType" AS ENUM ('single', 'multi_statement', 'match', 'assertion_reason', 'chronology', 'passage');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('draft', 'in_review', 'published', 'archived');

-- CreateEnum
CREATE TYPE "VersionStatus" AS ENUM ('draft', 'published', 'archived');

-- CreateEnum
CREATE TYPE "PaperStage" AS ENUM ('prelims', 'mains', 'interview');

-- CreateEnum
CREATE TYPE "FinalizedBy" AS ENUM ('client', 'auto_timer', 'admin');

-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'CONTENT_EDITOR', 'TEACHER', 'SUPPORT');

-- AlterEnum
ALTER TYPE "SessionRevokeReason" ADD VALUE 'SUSPENDED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "TestKind" ADD VALUE 'sectional';
ALTER TYPE "TestKind" ADD VALUE 'daily';

-- DropForeignKey
ALTER TABLE "Attempt" DROP CONSTRAINT "Attempt_testId_fkey";

-- DropForeignKey
ALTER TABLE "TestQuestion" DROP CONSTRAINT "TestQuestion_questionId_fkey";

-- DropForeignKey
ALTER TABLE "TestQuestion" DROP CONSTRAINT "TestQuestion_testId_fkey";

-- DropIndex
DROP INDEX "Attempt_testId_score_idx";

-- DropIndex
DROP INDEX "Attempt_userId_testId_idx";

-- DropIndex
DROP INDEX "Question_topicCode_difficulty_published_idx";

-- DropIndex
DROP INDEX "Test_examId_published_kind_idx";

-- AlterTable
ALTER TABLE "Attempt" DROP COLUMN "correct",
DROP COLUMN "maxScore",
DROP COLUMN "order",
DROP COLUMN "score",
DROP COLUMN "testId",
DROP COLUMN "timeSpentSec",
DROP COLUMN "unattempted",
DROP COLUMN "wrong",
ADD COLUMN     "attemptNo" INTEGER NOT NULL,
ADD COLUMN     "currentIndex" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "currentSection" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "finalizedBy" "FinalizedBy",
ADD COLUMN     "isPractice" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isRanked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "language" "Language" NOT NULL DEFAULT 'hi',
ADD COLUMN     "lastSyncAt" TIMESTAMP(3),
ADD COLUMN     "lockClientId" TEXT,
ADD COLUMN     "lockHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "questionOrder" TEXT[],
ADD COLUMN     "sectionStarts" JSONB,
ADD COLUMN     "stateSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "submitKey" TEXT,
ADD COLUMN     "testVersionId" UUID NOT NULL;

-- AlterTable
ALTER TABLE "AttemptAnswer" DROP CONSTRAINT "AttemptAnswer_pkey",
DROP COLUMN "flagged",
DROP COLUMN "questionId",
ADD COLUMN     "marked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "seq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tvqId" UUID NOT NULL,
ADD COLUMN     "visited" BOOLEAN NOT NULL DEFAULT false,
ADD CONSTRAINT "AttemptAnswer_pkey" PRIMARY KEY ("attemptId", "tvqId");

-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN     "actorType" TEXT NOT NULL DEFAULT 'system',
ADD COLUMN     "after" JSONB,
ADD COLUMN     "before" JSONB,
ADD COLUMN     "ip" TEXT,
ADD COLUMN     "targetType" TEXT;

-- AlterTable
ALTER TABLE "Exam" DROP COLUMN "correctMarks",
DROP COLUMN "mockSize",
DROP COLUMN "negativeFrac",
ADD COLUMN     "patternNote" TEXT,
ADD COLUMN     "patternSourceUrl" TEXT,
ADD COLUMN     "patternVerified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Question" DROP CONSTRAINT "Question_pkey",
DROP COLUMN "published",
DROP COLUMN "pyqPaper",
ADD COLUMN     "code" TEXT,
ADD COLUMN     "contentHash" TEXT NOT NULL,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "hasEn" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hasHi" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "imageKey" TEXT,
ADD COLUMN     "passageId" UUID,
ADD COLUMN     "pyqExamId" TEXT,
ADD COLUMN     "pyqPaperCode" TEXT,
ADD COLUMN     "reportedCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "status" "ContentStatus" NOT NULL DEFAULT 'draft',
ADD COLUMN     "subtopicCode" TEXT,
ADD COLUMN     "tags" TEXT[],
ADD COLUMN     "type" "QuestionType" NOT NULL DEFAULT 'single',
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "Question_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "Test" DROP CONSTRAINT "Test_pkey",
DROP COLUMN "attemptLimit",
DROP COLUMN "correctMarks",
DROP COLUMN "durationMin",
DROP COLUMN "endsAt",
DROP COLUMN "negativeFrac",
DROP COLUMN "published",
DROP COLUMN "shuffle",
DROP COLUMN "startsAt",
DROP COLUMN "title",
ADD COLUMN     "archived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "createdById" UUID,
ADD COLUMN     "paperId" TEXT,
ADD COLUMN     "publishedVersionId" UUID,
ADD COLUMN     "pyqYear" INTEGER,
ADD COLUMN     "subjectCode" TEXT,
ADD COLUMN     "titleEn" TEXT NOT NULL,
ADD COLUMN     "titleHi" TEXT NOT NULL,
ADD COLUMN     "topicCode" TEXT,
DROP COLUMN "id",
ADD COLUMN     "id" UUID NOT NULL,
ADD CONSTRAINT "Test_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "showOnLeaderboard" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'active',
ADD COLUMN     "suspendReason" TEXT,
ADD COLUMN     "suspendedAt" TIMESTAMP(3);

-- DropTable
DROP TABLE "TestQuestion";

-- CreateTable
CREATE TABLE "AdminUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "totpSecretEnc" TEXT,
    "totpEnabledAt" TIMESTAMP(3),
    "recoveryCodeHashes" TEXT[],
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "AdminUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdminSession" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "csrfToken" TEXT NOT NULL,
    "mfaDone" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AdminSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExamPaper" (
    "id" TEXT NOT NULL,
    "examId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "stage" "PaperStage" NOT NULL DEFAULT 'prelims',
    "nameEn" TEXT NOT NULL,
    "nameHi" TEXT NOT NULL,
    "questionCount" INTEGER NOT NULL,
    "totalMarks" DOUBLE PRECISION NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "correctMarks" DOUBLE PRECISION NOT NULL DEFAULT 2,
    "negativeFraction" DOUBLE PRECISION NOT NULL DEFAULT 0.3333333333,
    "qualifyingPct" DOUBLE PRECISION,
    "qualifyingPctReserved" DOUBLE PRECISION,
    "countsTowardMerit" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ExamPaper_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaperSubject" (
    "paperId" TEXT NOT NULL,
    "subjectCode" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "PaperSubject_pkey" PRIMARY KEY ("paperId","subjectCode")
);

-- CreateTable
CREATE TABLE "Subtopic" (
    "code" TEXT NOT NULL,
    "topicCode" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameHi" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Subtopic_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "Passage" (
    "id" UUID NOT NULL,
    "body" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Passage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionVersion" (
    "questionId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "body" JSONB NOT NULL,
    "answer" INTEGER NOT NULL,
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionVersion_pkey" PRIMARY KEY ("questionId","version")
);

-- CreateTable
CREATE TABLE "QuestionReport" (
    "id" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "QuestionReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Material" (
    "id" UUID NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleHi" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectCode" TEXT,
    "topicCode" TEXT,
    "examId" TEXT,
    "fileKey" TEXT,
    "url" TEXT,
    "access" "AccessLevel" NOT NULL DEFAULT 'free',
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "publishAt" TIMESTAMP(3),
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CurrentAffair" (
    "id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "category" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleHi" TEXT NOT NULL,
    "summaryEn" TEXT NOT NULL,
    "summaryHi" TEXT NOT NULL,
    "angleEn" TEXT,
    "angleHi" TEXT,
    "topicCode" TEXT,
    "tags" TEXT[],
    "sourceUrl" TEXT,
    "imageKey" TEXT,
    "quizTestId" TEXT,
    "access" "AccessLevel" NOT NULL DEFAULT 'free',
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "publishAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CurrentAffair_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DailyQuiz" (
    "date" DATE NOT NULL,
    "testId" TEXT NOT NULL,

    CONSTRAINT "DailyQuiz_pkey" PRIMARY KEY ("date")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'update',
    "titleEn" TEXT NOT NULL,
    "titleHi" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "bodyHi" TEXT NOT NULL,
    "examId" TEXT,
    "linkUrl" TEXT,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "publishAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" UUID NOT NULL,
    "examId" TEXT NOT NULL,
    "stage" "PaperStage" NOT NULL DEFAULT 'prelims',
    "labelEn" TEXT NOT NULL,
    "labelHi" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "sourceUrl" TEXT,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Faq" (
    "id" UUID NOT NULL,
    "keywords" TEXT NOT NULL,
    "qEn" TEXT NOT NULL,
    "qHi" TEXT NOT NULL,
    "aEn" TEXT NOT NULL,
    "aHi" TEXT NOT NULL,

    CONSTRAINT "Faq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InterviewQuestion" (
    "id" UUID NOT NULL,
    "examId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "qEn" TEXT NOT NULL,
    "qHi" TEXT NOT NULL,
    "pointsEn" TEXT NOT NULL,
    "pointsHi" TEXT NOT NULL,

    CONSTRAINT "InterviewQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestVersion" (
    "id" UUID NOT NULL,
    "testId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "VersionStatus" NOT NULL DEFAULT 'draft',
    "durationMin" INTEGER NOT NULL,
    "correctMarks" DOUBLE PRECISION NOT NULL,
    "negativeFraction" DOUBLE PRECISION NOT NULL,
    "qualifyingPct" DOUBLE PRECISION,
    "qualifyingPctReserved" DOUBLE PRECISION,
    "countsTowardMerit" BOOLEAN NOT NULL DEFAULT true,
    "shuffleQuestions" BOOLEAN NOT NULL DEFAULT true,
    "sectionalTimers" BOOLEAN NOT NULL DEFAULT false,
    "attemptLimit" INTEGER,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "resultReleaseAt" TIMESTAMP(3),
    "instructionsEn" TEXT,
    "instructionsHi" TEXT,
    "maxScore" DOUBLE PRECISION,
    "questionCount" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "publishedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSection" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "nameEn" TEXT NOT NULL,
    "nameHi" TEXT NOT NULL,
    "durationMin" INTEGER,

    CONSTRAINT "TestSection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestVersionQuestion" (
    "id" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "sectionId" UUID,
    "position" INTEGER NOT NULL,
    "questionId" UUID NOT NULL,
    "questionVersion" INTEGER NOT NULL,
    "marks" DOUBLE PRECISION,
    "snapshot" JSONB,

    CONSTRAINT "TestVersionQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSeries" (
    "id" UUID NOT NULL,
    "examId" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleHi" TEXT NOT NULL,
    "descEn" TEXT,
    "descHi" TEXT,
    "access" "AccessLevel" NOT NULL DEFAULT 'paid',
    "status" "ContentStatus" NOT NULL DEFAULT 'draft',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TestSeries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TestSeriesItem" (
    "seriesId" UUID NOT NULL,
    "testId" UUID NOT NULL,
    "position" INTEGER NOT NULL,

    CONSTRAINT "TestSeriesItem_pkey" PRIMARY KEY ("seriesId","testId")
);

-- CreateTable
CREATE TABLE "Enrollment" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "seriesId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttemptResult" (
    "attemptId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "testVersionId" UUID NOT NULL,
    "isRanked" BOOLEAN NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "maxScore" DOUBLE PRECISION NOT NULL,
    "correct" INTEGER NOT NULL,
    "wrong" INTEGER NOT NULL,
    "skipped" INTEGER NOT NULL,
    "negativeDeducted" DOUBLE PRECISION NOT NULL,
    "accuracyPct" DOUBLE PRECISION NOT NULL,
    "timeSpentSec" INTEGER NOT NULL,
    "sectionScores" JSONB NOT NULL,
    "topicScores" JSONB NOT NULL,
    "qualifiedGeneral" BOOLEAN,
    "qualifiedReserved" BOOLEAN,
    "submittedAt" TIMESTAMP(3) NOT NULL,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttemptResult_pkey" PRIMARY KEY ("attemptId")
);

-- CreateTable
CREATE TABLE "UserTopicStat" (
    "userId" UUID NOT NULL,
    "topicCode" TEXT NOT NULL,
    "attempted" INTEGER NOT NULL DEFAULT 0,
    "correct" INTEGER NOT NULL DEFAULT 0,
    "timeSec" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserTopicStat_pkey" PRIMARY KEY ("userId","topicCode")
);

-- CreateTable
CREATE TABLE "Bookmark" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "refId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bookmark_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserNote" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "questionId" UUID NOT NULL,
    "text" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleHi" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "bodyHi" TEXT NOT NULL,
    "data" JSONB,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NotificationTemplate" (
    "key" TEXT NOT NULL,
    "titleEn" TEXT NOT NULL,
    "titleHi" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "bodyHi" TEXT NOT NULL,

    CONSTRAINT "NotificationTemplate_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Doubt" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "contextType" TEXT NOT NULL,
    "contextId" TEXT,
    "examId" TEXT,
    "topicCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "slaDueAt" TIMESTAMP(3) NOT NULL,
    "firstResponseAt" TIMESTAMP(3),
    "answeredAt" TIMESTAMP(3),
    "rating" INTEGER,
    "reopened" BOOLEAN NOT NULL DEFAULT false,
    "abuse" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Doubt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoubtMessage" (
    "id" UUID NOT NULL,
    "doubtId" UUID NOT NULL,
    "authorType" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "attachmentKeys" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoubtMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CannedReply" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "bodyEn" TEXT NOT NULL,
    "bodyHi" TEXT NOT NULL,

    CONSTRAINT "CannedReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MentorRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "examId" TEXT NOT NULL,
    "hoursPerDay" DOUBLE PRECISION NOT NULL,
    "examDate" DATE,
    "status" TEXT NOT NULL DEFAULT 'open',
    "plan" JSONB,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MentorRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "ImportJob" (
    "id" UUID NOT NULL,
    "adminId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rowsTotal" INTEGER NOT NULL,
    "rowsOk" INTEGER NOT NULL,
    "rowsFailed" INTEGER NOT NULL,
    "errors" JSONB NOT NULL,
    "rows" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "committedAt" TIMESTAMP(3),

    CONSTRAINT "ImportJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdminUser_email_key" ON "AdminUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession"("tokenHash");

-- CreateIndex
CREATE INDEX "AdminSession_adminId_revokedAt_idx" ON "AdminSession"("adminId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExamPaper_examId_code_key" ON "ExamPaper"("examId", "code");

-- CreateIndex
CREATE INDEX "Subtopic_topicCode_idx" ON "Subtopic"("topicCode");

-- CreateIndex
CREATE INDEX "QuestionReport_status_createdAt_idx" ON "QuestionReport"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Material_status_examId_subjectCode_idx" ON "Material"("status", "examId", "subjectCode");

-- CreateIndex
CREATE INDEX "CurrentAffair_status_date_idx" ON "CurrentAffair"("status", "date");

-- CreateIndex
CREATE INDEX "CurrentAffair_category_date_idx" ON "CurrentAffair"("category", "date");

-- CreateIndex
CREATE INDEX "Announcement_status_publishAt_idx" ON "Announcement"("status", "publishAt");

-- CreateIndex
CREATE INDEX "CalendarEvent_examId_date_idx" ON "CalendarEvent"("examId", "date");

-- CreateIndex
CREATE INDEX "InterviewQuestion_examId_category_idx" ON "InterviewQuestion"("examId", "category");

-- CreateIndex
CREATE INDEX "TestVersion_status_idx" ON "TestVersion"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TestVersion_testId_version_key" ON "TestVersion"("testId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "TestSection_versionId_position_key" ON "TestSection"("versionId", "position");

-- CreateIndex
CREATE INDEX "TestVersionQuestion_versionId_sectionId_idx" ON "TestVersionQuestion"("versionId", "sectionId");

-- CreateIndex
CREATE UNIQUE INDEX "TestVersionQuestion_versionId_position_key" ON "TestVersionQuestion"("versionId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "Enrollment_userId_seriesId_key" ON "Enrollment"("userId", "seriesId");

-- CreateIndex
CREATE INDEX "AttemptResult_testVersionId_isRanked_score_timeSpentSec_idx" ON "AttemptResult"("testVersionId", "isRanked", "score" DESC, "timeSpentSec");

-- CreateIndex
CREATE INDEX "AttemptResult_userId_submittedAt_idx" ON "AttemptResult"("userId", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Bookmark_userId_kind_refId_key" ON "Bookmark"("userId", "kind", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "UserNote_userId_questionId_key" ON "UserNote"("userId", "questionId");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "Doubt_status_slaDueAt_idx" ON "Doubt"("status", "slaDueAt");

-- CreateIndex
CREATE INDEX "Doubt_userId_createdAt_idx" ON "Doubt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "DoubtMessage_doubtId_createdAt_idx" ON "DoubtMessage"("doubtId", "createdAt");

-- CreateIndex
CREATE INDEX "MentorRequest_userId_createdAt_idx" ON "MentorRequest"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "MentorRequest_status_idx" ON "MentorRequest"("status");

-- CreateIndex
CREATE INDEX "ImportJob_adminId_createdAt_idx" ON "ImportJob"("adminId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_orderId_key" ON "Invoice"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Invoice_number_key" ON "Invoice"("number");

-- CreateIndex
CREATE INDEX "Attempt_status_deadlineAt_idx" ON "Attempt"("status", "deadlineAt");

-- CreateIndex
CREATE INDEX "Attempt_userId_status_idx" ON "Attempt"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Attempt_userId_testVersionId_attemptNo_key" ON "Attempt"("userId", "testVersionId", "attemptNo");

-- CreateIndex
CREATE INDEX "AuditLog_actor_createdAt_idx" ON "AuditLog"("actor", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_targetType_target_idx" ON "AuditLog"("targetType", "target");

-- CreateIndex
CREATE UNIQUE INDEX "Question_code_key" ON "Question"("code");

-- CreateIndex
CREATE INDEX "Question_status_topicCode_difficulty_idx" ON "Question"("status", "topicCode", "difficulty");

-- CreateIndex
CREATE INDEX "Question_contentHash_idx" ON "Question"("contentHash");

-- CreateIndex
CREATE INDEX "Question_hasEn_hasHi_idx" ON "Question"("hasEn", "hasHi");

-- CreateIndex
CREATE INDEX "Question_pyqExamId_pyqYear_idx" ON "Question"("pyqExamId", "pyqYear");

-- CreateIndex
CREATE UNIQUE INDEX "Test_publishedVersionId_key" ON "Test"("publishedVersionId");

-- CreateIndex
CREATE INDEX "Test_examId_kind_archived_idx" ON "Test"("examId", "kind", "archived");

-- CreateIndex
CREATE INDEX "User_status_idx" ON "User"("status");

-- CreateIndex
CREATE INDEX "User_createdAt_idx" ON "User"("createdAt");

-- AddForeignKey
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "AdminUser"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExamPaper" ADD CONSTRAINT "ExamPaper_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSubject" ADD CONSTRAINT "PaperSubject_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ExamPaper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperSubject" ADD CONSTRAINT "PaperSubject_subjectCode_fkey" FOREIGN KEY ("subjectCode") REFERENCES "Subject"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Subtopic" ADD CONSTRAINT "Subtopic_topicCode_fkey" FOREIGN KEY ("topicCode") REFERENCES "Topic"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_subtopicCode_fkey" FOREIGN KEY ("subtopicCode") REFERENCES "Subtopic"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Question" ADD CONSTRAINT "Question_passageId_fkey" FOREIGN KEY ("passageId") REFERENCES "Passage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionVersion" ADD CONSTRAINT "QuestionVersion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionReport" ADD CONSTRAINT "QuestionReport_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEvent" ADD CONSTRAINT "CalendarEvent_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Test" ADD CONSTRAINT "Test_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "ExamPaper"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestVersion" ADD CONSTRAINT "TestVersion_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSection" ADD CONSTRAINT "TestSection_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "TestVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestVersionQuestion" ADD CONSTRAINT "TestVersionQuestion_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "TestVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestVersionQuestion" ADD CONSTRAINT "TestVersionQuestion_sectionId_fkey" FOREIGN KEY ("sectionId") REFERENCES "TestSection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSeries" ADD CONSTRAINT "TestSeries_examId_fkey" FOREIGN KEY ("examId") REFERENCES "Exam"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSeriesItem" ADD CONSTRAINT "TestSeriesItem_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "TestSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TestSeriesItem" ADD CONSTRAINT "TestSeriesItem_testId_fkey" FOREIGN KEY ("testId") REFERENCES "Test"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Enrollment" ADD CONSTRAINT "Enrollment_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "TestSeries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Attempt" ADD CONSTRAINT "Attempt_testVersionId_fkey" FOREIGN KEY ("testVersionId") REFERENCES "TestVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptResult" ADD CONSTRAINT "AttemptResult_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "Attempt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptResult" ADD CONSTRAINT "AttemptResult_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttemptResult" ADD CONSTRAINT "AttemptResult_testVersionId_fkey" FOREIGN KEY ("testVersionId") REFERENCES "TestVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserTopicStat" ADD CONSTRAINT "UserTopicStat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bookmark" ADD CONSTRAINT "Bookmark_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserNote" ADD CONSTRAINT "UserNote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Doubt" ADD CONSTRAINT "Doubt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoubtMessage" ADD CONSTRAINT "DoubtMessage_doubtId_fkey" FOREIGN KEY ("doubtId") REFERENCES "Doubt"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written constraints that Prisma cannot express.
-- ---------------------------------------------------------------------------

-- A student can have only one running attempt per test version.
CREATE UNIQUE INDEX "Attempt_one_active_per_user_version"
  ON "Attempt" ("userId", "testVersionId") WHERE "status" = 'in_progress';

-- Only one ranked attempt per student per test version (first attempt counts for rank).
CREATE UNIQUE INDEX "Attempt_one_ranked_per_user_version"
  ON "Attempt" ("userId", "testVersionId") WHERE "isRanked";

-- Sanity checks at the database level, independent of the application.
ALTER TABLE "Question" ADD CONSTRAINT "Question_answer_range" CHECK ("answer" BETWEEN 0 AND 3);
ALTER TABLE "Question" ADD CONSTRAINT "Question_difficulty_range" CHECK ("difficulty" BETWEEN 1 AND 3);
ALTER TABLE "AttemptAnswer" ADD CONSTRAINT "AttemptAnswer_selected_range" CHECK ("selected" IS NULL OR "selected" BETWEEN 0 AND 3);
ALTER TABLE "AttemptAnswer" ADD CONSTRAINT "AttemptAnswer_time_nonneg" CHECK ("timeSpentSec" >= 0);
ALTER TABLE "TestVersion" ADD CONSTRAINT "TestVersion_duration_positive" CHECK ("durationMin" > 0);
ALTER TABLE "TestVersion" ADD CONSTRAINT "TestVersion_negative_fraction" CHECK ("negativeFraction" >= 0 AND "negativeFraction" <= 1);
ALTER TABLE "ExamPaper" ADD CONSTRAINT "ExamPaper_negative_fraction" CHECK ("negativeFraction" >= 0 AND "negativeFraction" <= 1);
ALTER TABLE "Doubt" ADD CONSTRAINT "Doubt_rating_range" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);

-- Published test versions are immutable: block updates to scoring-relevant columns and to their questions.
CREATE OR REPLACE FUNCTION eg_block_published_version_edit() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'published' AND (
       NEW."durationMin" IS DISTINCT FROM OLD."durationMin" OR
       NEW."correctMarks" IS DISTINCT FROM OLD."correctMarks" OR
       NEW."negativeFraction" IS DISTINCT FROM OLD."negativeFraction" OR
       NEW."qualifyingPct" IS DISTINCT FROM OLD."qualifyingPct" OR
       NEW."qualifyingPctReserved" IS DISTINCT FROM OLD."qualifyingPctReserved" OR
       NEW."maxScore" IS DISTINCT FROM OLD."maxScore" OR
       NEW."questionCount" IS DISTINCT FROM OLD."questionCount" OR
       NEW."sectionalTimers" IS DISTINCT FROM OLD."sectionalTimers") THEN
    RAISE EXCEPTION 'test version % is published; create a new version instead', OLD."id" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "TestVersion_immutable_when_published"
  BEFORE UPDATE ON "TestVersion" FOR EACH ROW EXECUTE FUNCTION eg_block_published_version_edit();

CREATE OR REPLACE FUNCTION eg_block_published_questions_edit() RETURNS trigger AS $$
DECLARE v_status "VersionStatus"; v_id uuid;
BEGIN
  v_id := COALESCE(NEW."versionId", OLD."versionId");
  SELECT "status" INTO v_status FROM "TestVersion" WHERE "id" = v_id;
  IF v_status = 'published' AND TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'test version % is published; its questions are frozen', v_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$ LANGUAGE plpgsql;
CREATE TRIGGER "TestVersionQuestion_frozen_when_published"
  BEFORE UPDATE OR DELETE ON "TestVersionQuestion" FOR EACH ROW EXECUTE FUNCTION eg_block_published_questions_edit();

-- Receipt numbers.
CREATE SEQUENCE "invoice_number_seq" START 1;
