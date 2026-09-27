// SPDX-License-Identifier: AGPL-3.0-or-later
export type ReleaseConfig = Readonly<{schema: 'tcn-desktop-release/v1'; channel: 'stable' | 'canary'; feedUrl: string; downloadPageUrl: string}>;
export function parseVersion(value: string): {core: bigint[]; pre: string[]};
export function compareReleaseVersions(left: string, right: string): number;
export function validateReleaseConfig(value: unknown, expectedChannel: string): ReleaseConfig;
export function validateReleaseAsset(update: unknown, packageId: string, currentVersion: string, channel: string, source?: 'feed' | 'downloaded'): import('velopack').VelopackAsset;
