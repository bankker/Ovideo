-- AlterTable
ALTER TABLE "Shot" ADD COLUMN "lineageId" TEXT;

-- CreateIndex
CREATE INDEX "Shot_lineageId_idx" ON "Shot"("lineageId");
