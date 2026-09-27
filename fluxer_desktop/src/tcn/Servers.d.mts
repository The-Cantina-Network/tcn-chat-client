// SPDX-License-Identifier: AGPL-3.0-or-later
export interface Server {readonly id: string; readonly name: string; readonly origin: string; readonly partition: string; readonly branding: boolean;}
export interface ServerPreferences {selectedOrigin: string; customOrigins: string[];}
export const PRESET_SERVERS: readonly Server[];
export function normalizeServerOrigin(value: unknown): string;
export function serverFromOrigin(value: unknown): Server;
export function resolveServer(origin: unknown, options?: {fetchImpl?: typeof fetch}): Promise<Server & {requestOrigins: readonly string[]; webSocketOrigins: readonly string[]}>;
export function loadServerPreferences(file: string): Promise<ServerPreferences>;
export function saveServerPreferences(file: string, state: ServerPreferences): Promise<ServerPreferences>;
