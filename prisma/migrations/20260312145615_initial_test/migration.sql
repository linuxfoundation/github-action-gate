-- CreateTable
CREATE TABLE "Repository" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "githubId" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "installationId" INTEGER NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'AUDIT',
    "expiryDays" INTEGER NOT NULL DEFAULT 180,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Attestation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "repositoryId" TEXT NOT NULL,
    "workflowPath" TEXT NOT NULL,
    "jobName" TEXT,
    "voucherGithubLogin" TEXT NOT NULL,
    "voucherGithubId" INTEGER NOT NULL,
    "voucherOrgAffiliation" TEXT,
    "tier" TEXT NOT NULL,
    "orgGithubLogin" TEXT,
    "notes" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Attestation_repositoryId_fkey" FOREIGN KEY ("repositoryId") REFERENCES "Repository" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Repository_githubId_key" ON "Repository"("githubId");

-- CreateIndex
CREATE INDEX "Repository_owner_idx" ON "Repository"("owner");

-- CreateIndex
CREATE UNIQUE INDEX "Repository_owner_name_key" ON "Repository"("owner", "name");

-- CreateIndex
CREATE INDEX "Attestation_repositoryId_workflowPath_idx" ON "Attestation"("repositoryId", "workflowPath");

-- CreateIndex
CREATE INDEX "Attestation_repositoryId_workflowPath_jobName_idx" ON "Attestation"("repositoryId", "workflowPath", "jobName");

-- CreateIndex
CREATE INDEX "Attestation_voucherGithubLogin_idx" ON "Attestation"("voucherGithubLogin");

-- CreateIndex
CREATE INDEX "Attestation_orgGithubLogin_idx" ON "Attestation"("orgGithubLogin");

-- CreateIndex
CREATE INDEX "Attestation_expiresAt_idx" ON "Attestation"("expiresAt");
