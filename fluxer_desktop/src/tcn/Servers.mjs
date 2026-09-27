import {createHash, randomUUID} from 'node:crypto';
import {mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import {dirname} from 'node:path';

export const PRESET_SERVERS = Object.freeze([
  Object.freeze({id: 'tcn', name: 'TCN production', origin: 'https://chat.the-cantina.net', partition: 'persist:tcn-main', branding: true}),
  Object.freeze({id: 'tcn-staging', name: 'TCN staging', origin: 'https://chat.server60.the-cantina.net', partition: 'persist:tcn-staging', branding: true}),
  Object.freeze({id: 'fluxer', name: 'Fluxer', origin: 'https://web.fluxer.app', partition: 'persist:fluxer-official', branding: false}),
]);

const MAX_DISCOVERY_BYTES = 256 * 1024;
const MAX_CUSTOM_SERVERS = 32;
const DISCOVERY_TIMEOUT_MS = 8000;
const MISSING_DISCOVERY = new Set([404, 405, 410]);
const REQUEST_ENDPOINTS = new Set(['api', 'api_client', 'api_public', 'media', 'static_cdn']);

function parseSecureUrl(value, protocol) {
  if (typeof value !== 'string' || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(value)
    || !value.toLowerCase().startsWith(`${protocol}//`)) throw new Error('Enter a complete secure server URL.');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid server URL.');
  }
  if (url.protocol !== protocol || !url.hostname || url.username || url.password || url.hostname.endsWith('.')
    || value.includes('?') || value.includes('#')) throw new Error('Server URLs cannot include credentials, queries, or fragments.');
  return url;
}

export function normalizeServerOrigin(value) {
  const url = parseSecureUrl(value, 'https:');
  // Inspect the supplied path as well: URL normalization would otherwise hide /.. and /.
  if (!/^https:\/\/[^/?#]+\/?$/iu.test(value) || url.pathname !== '/') {
    throw new Error('Enter the server origin without a path.');
  }
  return url.origin;
}

export function serverFromOrigin(value) {
  const origin = normalizeServerOrigin(value);
  const preset = PRESET_SERVERS.find(server => server.origin === origin);
  if (preset) return preset;
  const digest = createHash('sha256').update(origin).digest('hex');
  return Object.freeze({
    id: `custom-${digest}`,
    name: new URL(origin).host,
    origin,
    partition: `persist:custom-${digest}`,
    branding: false,
  });
}

async function readDiscovery(response) {
  const declaredSize = response.headers.get('content-length');
  if (declaredSize !== null && Number(declaredSize) > MAX_DISCOVERY_BYTES) {
    await response.body?.cancel();
    throw new Error('Server discovery is too large.');
  }
  if (!response.body) throw new Error('Server discovery is empty.');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DISCOVERY_BYTES) {
        await reader.cancel();
        throw new Error('Server discovery is too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks, size)));
  } catch {
    throw new Error('Server discovery is not valid JSON.');
  }
}

function validateDiscovery(server, discovery) {
  const endpoints = discovery?.endpoints;
  if (!endpoints || typeof endpoints !== 'object' || Array.isArray(endpoints)
    || !('api_client' in endpoints || 'api' in endpoints) || !('gateway' in endpoints)) {
    throw new Error('Server discovery must include API and gateway endpoints.');
  }
  const requestOrigins = new Set([server.origin]);
  const webSocketOrigins = new Set();
  for (const [name, value] of Object.entries(endpoints)) {
    let endpoint;
    try {
      endpoint = parseSecureUrl(value, name === 'gateway' ? 'wss:' : 'https:');
    } catch {
      throw new Error('Server discovery contains an invalid or insecure endpoint.');
    }
    if (name === 'webapp' && endpoint.origin !== server.origin) {
      throw new Error('Server discovery points to a different web application.');
    }
    if (REQUEST_ENDPOINTS.has(name)) requestOrigins.add(endpoint.origin);
    if (name === 'gateway') webSocketOrigins.add(endpoint.origin);
  }
  return Object.freeze({
    ...server,
    requestOrigins: Object.freeze([...requestOrigins]),
    webSocketOrigins: Object.freeze([...webSocketOrigins]),
  });
}

export async function resolveServer(origin, {fetchImpl = fetch} = {}) {
  const server = serverFromOrigin(origin);
  const signal = AbortSignal.timeout(DISCOVERY_TIMEOUT_MS);
  const paths = ['/api/.well-known/fluxer', '/.well-known/fluxer'];
  for (const path of paths) {
    const url = `${server.origin}${path}`;
    let response;
    try {
      response = await fetchImpl(url, {method: 'GET', credentials: 'omit', redirect: 'error', signal, headers: {Accept: 'application/json'}});
    } catch {
      throw new Error('Could not reach server discovery. Check the server address and connection.');
    }
    if (response.redirected || (response.url && response.url !== url) || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new Error('Server discovery cannot redirect to another address.');
    }
    if (MISSING_DISCOVERY.has(response.status)) {
      await response.body?.cancel();
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('The server did not return usable Fluxer discovery.');
    }
    return validateDiscovery(server, await readDiscovery(response));
  }
  throw new Error('No Fluxer discovery was found at this server.');
}

function defaultPreferences() {
  return {selectedOrigin: PRESET_SERVERS[0].origin, customOrigins: []};
}

function validatePreferences(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state)
    || Object.keys(state).some(key => !['selectedOrigin', 'customOrigins'].includes(key))
    || !Array.isArray(state.customOrigins) || state.customOrigins.length > MAX_CUSTOM_SERVERS) {
    throw new Error('Invalid server preferences.');
  }
  const selectedOrigin = normalizeServerOrigin(state.selectedOrigin);
  const customOrigins = [...new Set(state.customOrigins.map(normalizeServerOrigin))]
    .filter(origin => !PRESET_SERVERS.some(server => server.origin === origin));
  if (!PRESET_SERVERS.some(server => server.origin === selectedOrigin) && !customOrigins.includes(selectedOrigin)) {
    throw new Error('The selected custom server must be saved in the server list.');
  }
  return {selectedOrigin, customOrigins};
}

export async function loadServerPreferences(file) {
  let contents;
  try {
    contents = await readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return defaultPreferences();
    throw error;
  }
  try {
    if (Buffer.byteLength(contents) > 64 * 1024) return defaultPreferences();
    return validatePreferences(JSON.parse(contents));
  } catch {
    // Never overwrite a corrupt file during load; the caller can report future save failures.
    return defaultPreferences();
  }
}

export async function saveServerPreferences(file, state) {
  const preferences = validatePreferences(state);
  const temporary = `${file}.${randomUUID()}.tmp`;
  await mkdir(dirname(file), {recursive: true});
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(preferences, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, file);
  } finally {
    await handle?.close();
    await rm(temporary, {force: true});
  }
  return preferences;
}
