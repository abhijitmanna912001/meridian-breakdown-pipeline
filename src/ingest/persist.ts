import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { prisma } from "../lib/db.js";
import { ingestFleetCsv, type ResolvedVehicleRecord } from "./fleet.js";
import { ingestDriversCsv, type ResolvedDriverRecord } from "./drivers.js";
import { ingestTripsCsv, type ResolvedTripRecord } from "./trips.js";

/**
 * Persistence layer: takes what the pure-function ingestion modules
 * (fleet.ts, drivers.ts, trips.ts) resolved in memory and writes it
 * into the Prisma-backed SQLite store.
 *
 * Idempotency design: each source file's content is hashed, and an
 * IngestionRun row is written keyed on (sourceFile, fileHash) with a
 * unique constraint. If this exact file (byte-for-byte) has already
 * been ingested, we skip re-processing it — this is what makes
 * "run the whole pipeline twice, get identical output" true for the
 * ingestion stage specifically, not just for ticket processing.
 *
 * Vehicle/Driver/Client upserts use their natural unique keys
 * (registrationNumber / driverId / canonicalName), so even without
 * the file-hash guard, re-running ingestion on the SAME data can
 * never create duplicate entity rows — upsert, not insert.
 */

function hashFileContent(filePath: string): string {
  const content = readFileSync(filePath, "utf-8");
  return createHash("sha256").update(content).digest("hex");
}

async function alreadyIngested(sourceFile: string, fileHash: string): Promise<boolean> {
  const existing = await prisma.ingestionRun.findUnique({
    where: { sourceFile_fileHash: { sourceFile, fileHash } },
  });
  return existing !== null;
}

async function recordIngestionRun(params: {
  sourceFile: string;
  fileHash: string;
  ticketCount: number;
  duplicateCount: number;
  quarantineCount: number;
}): Promise<void> {
  await prisma.ingestionRun.create({
    data: {
      sourceFile: params.sourceFile,
      fileHash: params.fileHash,
      ticketCount: params.ticketCount,
      duplicateCount: params.duplicateCount,
      quarantineCount: params.quarantineCount,
      completedAt: new Date(),
    },
  });
}

async function upsertVehicle(record: ResolvedVehicleRecord): Promise<string> {
  const vehicle = await prisma.vehicle.upsert({
    where: { registrationNumber: record.registrationNumber },
    update: {
      // vehicleId can arrive later (e.g. if the primary row is seen
      // in a subsequent file); backfill it if we don't have one yet.
      vehicleId: record.vehicleId ?? undefined,
      rawRegistrations: JSON.stringify(
        Array.from(
          new Set([
            ...JSON.parse(
              (
                await prisma.vehicle.findUnique({
                  where: { registrationNumber: record.registrationNumber },
                  select: { rawRegistrations: true },
                })
              )?.rawRegistrations ?? "[]"
            ),
            ...record.rawRegistrations,
          ])
        )
      ),
      model: record.model ?? undefined,
      year: record.year ?? undefined,
      bsStage: record.bsStage ?? undefined,
      engineHeater: record.engineHeater || undefined,
      homeHub: record.homeHub ?? undefined,
      capacityTonnes: record.capacityTonnes ?? undefined,
      status: record.status ?? undefined,
    },
    create: {
      vehicleId: record.vehicleId ?? `UNASSIGNED-${record.registrationNumber}`,
      registrationNumber: record.registrationNumber,
      rawRegistrations: JSON.stringify(record.rawRegistrations),
      model: record.model,
      year: record.year,
      bsStage: record.bsStage,
      engineHeater: record.engineHeater,
      homeHub: record.homeHub,
      capacityTonnes: record.capacityTonnes,
      status: record.status,
    },
  });
  return vehicle.id;
}

async function upsertDriver(record: ResolvedDriverRecord): Promise<string> {
  const driver = await prisma.driver.upsert({
    where: { driverId: record.driverId },
    update: {
      maskedRef: record.maskedRef,
      joiningDate: record.joiningDate ?? undefined,
      homeHub: record.homeHub ?? undefined,
      isNewDriver: record.isNewDriver,
    },
    create: {
      driverId: record.driverId,
      maskedRef: record.maskedRef,
      joiningDate: record.joiningDate,
      homeHub: record.homeHub,
      isNewDriver: record.isNewDriver,
    },
  });
  return driver.id;
}

/**
 * Resolves a Client row by canonical name, creating it on first sight.
 * SLA/special-rule fields are intentionally left null here — those
 * come from the LLM-assisted pass over the interview transcript and
 * emails (a separate ingestion stage), not from the trips CSV, which
 * only tells us a client NAME exists, not their operating rules.
 */
async function resolveClientId(canonicalName: string): Promise<string> {
  const client = await prisma.client.upsert({
    where: { canonicalName },
    update: {},
    create: {
      canonicalName,
      nameVariants: JSON.stringify([canonicalName]),
    },
  });
  return client.id;
}

export interface FleetPersistSummary {
  skipped: boolean;
  vehiclesUpserted: number;
  quarantined: number;
  duplicateRowsMerged: number;
}

export async function persistFleetCsv(filePath: string): Promise<FleetPersistSummary> {
  const fileHash = hashFileContent(filePath);

  if (await alreadyIngested(filePath, fileHash)) {
    return { skipped: true, vehiclesUpserted: 0, quarantined: 0, duplicateRowsMerged: 0 };
  }

  const result = ingestFleetCsv(filePath);

  for (const vehicle of result.vehicles) {
    await upsertVehicle(vehicle);
  }

  await recordIngestionRun({
    sourceFile: filePath,
    fileHash,
    ticketCount: result.vehicles.length,
    duplicateCount: result.duplicateRowsMerged,
    quarantineCount: result.quarantined.length,
  });

  return {
    skipped: false,
    vehiclesUpserted: result.vehicles.length,
    quarantined: result.quarantined.length,
    duplicateRowsMerged: result.duplicateRowsMerged,
  };
}

export interface DriversPersistSummary {
  skipped: boolean;
  driversUpserted: number;
  quarantined: number;
}

export async function persistDriversCsv(filePath: string): Promise<DriversPersistSummary> {
  const fileHash = hashFileContent(filePath);

  if (await alreadyIngested(filePath, fileHash)) {
    return { skipped: true, driversUpserted: 0, quarantined: 0 };
  }

  const result = ingestDriversCsv(filePath);

  for (const driver of result.drivers) {
    await upsertDriver(driver);
  }

  await recordIngestionRun({
    sourceFile: filePath,
    fileHash,
    ticketCount: result.drivers.length,
    duplicateCount: 0, // driver_id has no observed duplicate-row pattern like fleet does
    quarantineCount: result.quarantined.length,
  });

  return {
    skipped: false,
    driversUpserted: result.drivers.length,
    quarantined: result.quarantined.length,
  };
}

export interface TripsPersistSummary {
  skipped: boolean;
  tripsUpserted: number;
  quarantined: number;
  unmatchedVehicleRegs: number; // trips whose vehicle_reg has no resolved Vehicle yet
}

export async function persistTripsCsv(filePath: string): Promise<TripsPersistSummary> {
  const fileHash = hashFileContent(filePath);

  if (await alreadyIngested(filePath, fileHash)) {
    return { skipped: true, tripsUpserted: 0, quarantined: 0, unmatchedVehicleRegs: 0 };
  }

  const result = ingestTripsCsv(filePath);
  let unmatchedVehicleRegs = 0;

  // Resolve all distinct clients seen up front, once each.
  const clientIdByName = new Map<string, string>();
  for (const name of result.clientNamesSeen) {
    if (name === "Internal") continue; // not a billable client, don't create a Client row
    clientIdByName.set(name, await resolveClientId(name));
  }

  for (const trip of result.trips) {
    const vehicle = await prisma.vehicle.findUnique({
      where: { registrationNumber: trip.vehicleRegistration },
      select: { id: true },
    });

    if (!vehicle) unmatchedVehicleRegs += 1;

    const clientId = trip.client ? clientIdByName.get(trip.client) : undefined;

    await prisma.trip.upsert({
      where: { tripId: trip.tripId },
      update: {}, // trip rows are immutable historical facts once written
      create: {
        tripId: trip.tripId,
        createdAtSource: trip.createdAt,
        routeType: trip.routeType,
        originCenter: trip.originCenter,
        originName: trip.originName,
        destCenter: trip.destCenter,
        destName: trip.destName,
        dispatchTime: trip.dispatchTime,
        deliveryTime: trip.deliveryTime,
        osrmDistanceKm: trip.osrmDistanceKm,
        osrmTimeMin: trip.osrmTimeMin,
        actualTimeMin: trip.actualTimeMin,
        vehicleRegRaw: trip.vehicleRegistration,
        driverId: trip.driverId,
        status: trip.status,
        billedAmount: trip.billedAmount,
        vehicleId: vehicle?.id,
        clientId: clientId ?? null,
      },
    });
  }

  await recordIngestionRun({
    sourceFile: filePath,
    fileHash,
    ticketCount: result.trips.length,
    duplicateCount: 0,
    quarantineCount: result.quarantined.length,
  });

  return {
    skipped: false,
    tripsUpserted: result.trips.length,
    quarantined: result.quarantined.length,
    unmatchedVehicleRegs,
  };
}
