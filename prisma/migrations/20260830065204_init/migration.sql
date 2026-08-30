-- CreateTable
CREATE TABLE "Vehicle" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vehicleId" TEXT NOT NULL,
    "registrationNumber" TEXT NOT NULL,
    "rawRegistrations" TEXT NOT NULL,
    "model" TEXT,
    "year" INTEGER,
    "bsStage" TEXT,
    "engineHeater" BOOLEAN NOT NULL DEFAULT false,
    "homeHub" TEXT,
    "capacityTonnes" REAL,
    "status" TEXT,
    "lastServiceDate" DATETIME,
    "lastBrakeWorkDate" DATETIME,
    "jugaadPatchedAt" DATETIME,
    "jugaadDeadline" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "driverId" TEXT NOT NULL,
    "maskedRef" TEXT NOT NULL,
    "joiningDate" DATETIME,
    "homeHub" TEXT,
    "isNewDriver" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "canonicalName" TEXT NOT NULL,
    "nameVariants" TEXT NOT NULL,
    "contractSlaHours" REAL,
    "effectiveSlaHours" REAL,
    "slaSourceNote" TEXT,
    "specialRules" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ResolvedFact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fieldName" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "sourceFile" TEXT NOT NULL,
    "sourceLocator" TEXT,
    "conflictsWith" TEXT,
    "precedenceRule" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "MaskedFieldMap" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "fieldType" TEXT NOT NULL,
    "hashOfRaw" TEXT NOT NULL,
    "maskedToken" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "BreakdownTicket" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "rawPayload" TEXT NOT NULL,
    "createdAtSource" DATETIME,
    "ingestedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicleId" TEXT,
    "driverId" TEXT,
    "clientId" TEXT,
    "severity" TEXT,
    "quarantineReason" TEXT,
    CONSTRAINT "BreakdownTicket_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BreakdownTicket_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "BreakdownTicket_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WorkOrder" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workOrderId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "vehicleRegUsed" TEXT NOT NULL,
    "vehicleId" TEXT,
    "citations" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WorkOrder_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "BreakdownTicket" ("ticketId") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "WorkOrder_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ClientMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "messageId" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "citations" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "approvedBy" TEXT,
    "sentAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ClientMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "BreakdownTicket" ("ticketId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ticketId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "ruleCited" TEXT,
    "sourceData" TEXT,
    "actor" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AuditEvent_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "BreakdownTicket" ("ticketId") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sourceFile" TEXT NOT NULL,
    "fileHash" TEXT NOT NULL,
    "ticketCount" INTEGER NOT NULL,
    "duplicateCount" INTEGER NOT NULL,
    "quarantineCount" INTEGER NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" DATETIME
);

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_vehicleId_key" ON "Vehicle"("vehicleId");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_registrationNumber_key" ON "Vehicle"("registrationNumber");

-- CreateIndex
CREATE INDEX "Vehicle_registrationNumber_idx" ON "Vehicle"("registrationNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_driverId_key" ON "Driver"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_maskedRef_key" ON "Driver"("maskedRef");

-- CreateIndex
CREATE INDEX "Driver_driverId_idx" ON "Driver"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_canonicalName_key" ON "Client"("canonicalName");

-- CreateIndex
CREATE INDEX "ResolvedFact_entityType_entityId_fieldName_idx" ON "ResolvedFact"("entityType", "entityId", "fieldName");

-- CreateIndex
CREATE UNIQUE INDEX "MaskedFieldMap_hashOfRaw_key" ON "MaskedFieldMap"("hashOfRaw");

-- CreateIndex
CREATE UNIQUE INDEX "MaskedFieldMap_maskedToken_key" ON "MaskedFieldMap"("maskedToken");

-- CreateIndex
CREATE UNIQUE INDEX "BreakdownTicket_ticketId_key" ON "BreakdownTicket"("ticketId");

-- CreateIndex
CREATE INDEX "BreakdownTicket_status_idx" ON "BreakdownTicket"("status");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_workOrderId_key" ON "WorkOrder"("workOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkOrder_ticketId_key" ON "WorkOrder"("ticketId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessage_messageId_key" ON "ClientMessage"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ClientMessage_ticketId_key" ON "ClientMessage"("ticketId");

-- CreateIndex
CREATE INDEX "AuditEvent_ticketId_step_idx" ON "AuditEvent"("ticketId", "step");

-- CreateIndex
CREATE UNIQUE INDEX "IngestionRun_sourceFile_fileHash_key" ON "IngestionRun"("sourceFile", "fileHash");
