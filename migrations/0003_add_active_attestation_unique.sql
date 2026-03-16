-- Partial unique index that prevents duplicate *active* attestations for the
-- same (repositoryId, workflowPath, jobName) combination.  "Active" means the
-- attestation has not been revoked (revokedAt IS NULL) and has not yet expired
-- (expiresAt > current time — but the expiry check is enforced at the
-- application layer since SQLite doesn't allow non-deterministic functions in
-- partial indexes).  The revokedAt IS NULL condition is the critical part: once
-- an attestation is revoked, a new one can be created for the same target.
CREATE UNIQUE INDEX "Attestation_active_unique"
ON "Attestation" ("repositoryId", "workflowPath", "jobName")
WHERE "revokedAt" IS NULL;
