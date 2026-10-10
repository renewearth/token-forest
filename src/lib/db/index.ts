import mongoose from "mongoose";

// No default URI on purpose: a script that forgets to set MONGODB_URI must
// fail loudly instead of silently connecting to (and possibly mutating or
// dropping) the production database. Every runner — docker compose, dev, CLI,
// tests — passes it explicitly.
function mongoUri(): string {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error(
      "MONGODB_URI is not set. Refusing to guess a database — set it explicitly (production: mongodb://127.0.0.1:27017/token-meter).",
    );
  }
  return uri;
}

// Reuse one connection across Next.js hot reloads / route handlers, and make
// concurrent callers share the same in-flight connect.
const globalForDb = globalThis as unknown as {
  __tokenMeterMongo?: Promise<typeof mongoose>;
};

export function connectDb(): Promise<typeof mongoose> {
  return (globalForDb.__tokenMeterMongo ??= mongoose.connect(mongoUri(), {
    serverSelectionTimeoutMS: 5000,
    ...(process.env.TOKEN_FOREST_READ_ONLY === "1"
      ? { autoCreate: false, autoIndex: false }
      : {}),
  }));
}

// For CLI scripts: mongoose keeps the event loop alive; call this before exit.
export async function closeDb(): Promise<void> {
  if (globalForDb.__tokenMeterMongo) {
    await mongoose.disconnect();
    globalForDb.__tokenMeterMongo = undefined;
  }
}

export * from "./models";
