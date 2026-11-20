import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { SqliteD1 } from './sqlite-d1';

const dataDirectory = resolve(process.env.DATA_DIR || './data');
const migrationsDirectory = process.env.MIGRATIONS_DIR
  ? resolve(process.env.MIGRATIONS_DIR)
  : fileURLToPath(new URL('../migrations/', import.meta.url));

export const database = new SqliteD1(resolve(dataDirectory, 'tongzai.sqlite'));
database.migrate(migrationsDirectory);

/** Vite replaces cloudflare:workers with this module for the standalone Node build only. */
export const env = {
  DB: database as unknown as D1Database,
  LIVEKIT_URL: process.env.LIVEKIT_URL,
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
  STUN_URLS: process.env.STUN_URLS,
  TURN_URL: process.env.TURN_URL,
  TURN_USERNAME: process.env.TURN_USERNAME,
  TURN_CREDENTIAL: process.env.TURN_CREDENTIAL,
  TURN_SHARED_SECRET: process.env.TURN_SHARED_SECRET,
  TURN_TTL_SECONDS: process.env.TURN_TTL_SECONDS,
  ICE_TRANSPORT_POLICY: process.env.ICE_TRANSPORT_POLICY,
};
