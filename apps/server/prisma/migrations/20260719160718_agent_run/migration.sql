-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "shotId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "maxRounds" INTEGER NOT NULL DEFAULT 3,
    "roundsJson" TEXT NOT NULL DEFAULT '[]',
    "finalTakeId" TEXT,
    "humanOverride" BOOLEAN NOT NULL DEFAULT false,
    "jobId" TEXT,
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateIndex
CREATE INDEX "AgentRun_shotId_idx" ON "AgentRun"("shotId");
