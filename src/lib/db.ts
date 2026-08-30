import "dotenv/config";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { PrismaClient } from "../generated/prisma/client.js";

// Prisma ORM 7 requires an explicit driver adapter for every database,
// including SQLite — there is no more "just works" default connection.
//
// We use @prisma/adapter-libsql (not @prisma/adapter-better-sqlite3)
// deliberately: better-sqlite3 ships native compiled bindings that only
// have prebuilt binaries for specific Node versions, and as of this
// writing there is no prebuilt binary for newer Node releases — it
// would silently fall back to compiling from source via node-gyp,
// which can fail without local build tools installed. libsql's SQLite
// driver has no such native-binding requirement, so it's the safer
// choice for "runs on a clean machine with one command" — the exact
// requirement this project is scored on.
//
// This is the single place the pipeline, the query CLI, and the tests
// all get their PrismaClient from, so the adapter/config only needs
// to be right in one spot.
const adapter = new PrismaLibSql({
  url: process.env.DATABASE_URL || "file:./dev.db",
});

export const prisma = new PrismaClient({ adapter });
