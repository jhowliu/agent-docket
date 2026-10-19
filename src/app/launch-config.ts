import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseLaunch } from '../execution/index.js';
import type { Launch } from '../execution/index.js';

export function launchFingerprint(launch: Launch): string {
  return createHash('sha256').update(JSON.stringify(launch)).digest('hex');
}

/** Trusted operator file; clients cannot submit executable or filesystem settings. */
export async function loadLaunchConfig(path: string) {
  const input: unknown = JSON.parse(await readFile(resolve(path), 'utf8'));
  const launch = parseLaunch(input);
  return { launch, configurationId: launchFingerprint(launch) };
}
