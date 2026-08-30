-- CreateTable
CREATE TABLE "Trip" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tripId" TEXT NOT NULL,
    "createdAtSource" DATETIME,
    "routeType" TEXT,
    "originCenter" TEXT,
    "originName" TEXT,
    "destCenter" TEXT,
    "destName" TEXT,
    "dispatchTime" DATETIME,
    "deliveryTime" DATETIME,
    "osrmDistanceKm" REAL,
    "osrmTimeMin" REAL,
    "actualTimeMin" REAL,
    "vehicleRegRaw" TEXT NOT NULL,
    "driverId" TEXT,
    "status" TEXT,
    "billedAmount" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "vehicleId" TEXT,
    "clientId" TEXT,
    CONSTRAINT "Trip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Trip_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Trip_tripId_key" ON "Trip"("tripId");

-- CreateIndex
CREATE INDEX "Trip_vehicleId_idx" ON "Trip"("vehicleId");

-- CreateIndex
CREATE INDEX "Trip_clientId_idx" ON "Trip"("clientId");
