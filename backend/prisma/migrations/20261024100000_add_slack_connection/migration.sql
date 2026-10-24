ALTER TABLE "User"
ADD COLUMN "slackAccessTokenEncrypted" TEXT,
ADD COLUMN "slackUserId" TEXT,
ADD COLUMN "slackTeamId" TEXT,
ADD COLUMN "slackConnectedAt" TIMESTAMP(3);