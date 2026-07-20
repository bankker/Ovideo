-- CreateTable
CREATE TABLE "Scene" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storyboardId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "interiorExterior" TEXT NOT NULL DEFAULT '',
    "timeOfDay" TEXT NOT NULL DEFAULT '',
    "sourceText" TEXT NOT NULL DEFAULT '',
    "estimatedDurationMs" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "lineageId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Scene_storyboardId_fkey" FOREIGN KEY ("storyboardId") REFERENCES "Storyboard" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Shot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "storyboardId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "sceneId" TEXT,
    "sourceText" TEXT NOT NULL DEFAULT '',
    "imagePrompt" TEXT NOT NULL DEFAULT '',
    "videoPrompt" TEXT NOT NULL DEFAULT '',
    "shotSize" TEXT NOT NULL DEFAULT '',
    "cameraAngle" TEXT NOT NULL DEFAULT '',
    "cameraMovement" TEXT NOT NULL DEFAULT '',
    "composition" TEXT NOT NULL DEFAULT '',
    "transition" TEXT NOT NULL DEFAULT '',
    "durationPlannedMs" INTEGER NOT NULL DEFAULT 12000,
    "durationLockedMs" INTEGER,
    "groupId" TEXT,
    "groupIndex" INTEGER,
    "lineageId" TEXT,
    "keyframeSelectedTakeId" TEXT,
    "videoSelectedTakeId" TEXT,
    "keyframeStale" BOOLEAN NOT NULL DEFAULT false,
    "videoStale" BOOLEAN NOT NULL DEFAULT false,
    "staleReasonsJson" TEXT NOT NULL DEFAULT '[]',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Shot_storyboardId_fkey" FOREIGN KEY ("storyboardId") REFERENCES "Storyboard" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Shot_sceneId_fkey" FOREIGN KEY ("sceneId") REFERENCES "Scene" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Shot" ("createdAt", "durationLockedMs", "durationPlannedMs", "groupId", "groupIndex", "id", "imagePrompt", "keyframeSelectedTakeId", "keyframeStale", "lineageId", "sortOrder", "sourceText", "staleReasonsJson", "storyboardId", "videoPrompt", "videoSelectedTakeId", "videoStale") SELECT "createdAt", "durationLockedMs", "durationPlannedMs", "groupId", "groupIndex", "id", "imagePrompt", "keyframeSelectedTakeId", "keyframeStale", "lineageId", "sortOrder", "sourceText", "staleReasonsJson", "storyboardId", "videoPrompt", "videoSelectedTakeId", "videoStale" FROM "Shot";
DROP TABLE "Shot";
ALTER TABLE "new_Shot" RENAME TO "Shot";
CREATE INDEX "Shot_lineageId_idx" ON "Shot"("lineageId");
CREATE INDEX "Shot_sceneId_idx" ON "Shot"("sceneId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Scene_storyboardId_idx" ON "Scene"("storyboardId");

-- CreateIndex
CREATE INDEX "Scene_lineageId_idx" ON "Scene"("lineageId");
