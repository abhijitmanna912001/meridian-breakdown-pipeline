import "dotenv/config";
import { join } from "node:path";
import { persistFleetCsv, persistDriversCsv, persistTripsCsv } from "./persist.js";

/**
 * Entity resolution entry point — run standalone via `npm run ingest`,
 * and also called by the full pipeline before ticket processing begins.
 *
 * Order matters: fleet must run before trips, so Trip rows can resolve
 * their vehicleId against already-upserted Vehicle rows. Drivers has
 * no dependency on the other two and could run in any order.
 */
async function main() {
  const bundlePath = process.env.CANDIDATE_BUNDLE_PATH ?? "../candidate_bundle";

  console.log("── Entity resolution: structured CSV ingestion ──\n");

  const fleetResult = await persistFleetCsv(join(bundlePath, "fleet_master.csv"));
  console.log(
    fleetResult.skipped
      ? "fleet_master.csv: already ingested, skipped (idempotent)"
      : `fleet_master.csv: ${fleetResult.vehiclesUpserted} vehicles resolved ` +
          `(${fleetResult.duplicateRowsMerged} duplicate rows merged, ` +
          `${fleetResult.quarantined} quarantined)`
  );

  const driversResult = await persistDriversCsv(join(bundlePath, "drivers_roster.csv"));
  console.log(
    driversResult.skipped
      ? "drivers_roster.csv: already ingested, skipped (idempotent)"
      : `drivers_roster.csv: ${driversResult.driversUpserted} drivers resolved ` +
          `(${driversResult.quarantined} quarantined) — all PII masked at read time`
  );

  const tripsResult = await persistTripsCsv(join(bundlePath, "meridian_trips.csv"));
  console.log(
    tripsResult.skipped
      ? "meridian_trips.csv: already ingested, skipped (idempotent)"
      : `meridian_trips.csv: ${tripsResult.tripsUpserted} trips resolved ` +
          `(${tripsResult.quarantined} quarantined, ` +
          `${tripsResult.unmatchedVehicleRegs} trips reference a vehicle not in fleet_master)`
  );

  console.log("\nDone. Re-run this command — outputs should report 'already ingested, skipped'.");
}

main()
  .catch((err) => {
    console.error("Ingestion failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("../lib/db.js");
    await prisma.$disconnect();
  });
