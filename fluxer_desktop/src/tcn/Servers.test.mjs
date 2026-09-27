import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, mkdir, readdir, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PRESET_SERVERS, normalizeServerOrigin, serverFromOrigin, resolveServer, loadServerPreferences, saveServerPreferences} from './Servers.mjs';

const origin = 'https://chat.example.test';
const discovery = (endpoints = {}) => ({endpoints: {
  api: `${origin}/api`, gateway: 'wss://chat.example.test/gateway', webapp: origin, ...endpoints,
}});
const jsonResponse = (data) => new Response(JSON.stringify(data), {headers: {'content-type': 'application/json'}});

test('server origins require secure root URLs and canonicalize harmless variants', () => {
  assert.equal(normalizeServerOrigin('HTTPS://CHAT.EXAMPLE.TEST:443/'), origin);
  assert.equal(normalizeServerOrigin('https://chat.lan:8443/'), 'https://chat.lan:8443');
  assert.equal(normalizeServerOrigin('https://[::1]:8443/'), 'https://[::1]:8443');
  for (const input of [null, '', 'chat.example.test', 'https:chat.example.test', 'http://chat.example.test',
    'https://user:secret@chat.example.test', 'https://chat.example.test\n', ' https://chat.example.test',
    'https://chat.example.test\\@other.test', `${origin}/login`, `${origin}/.`, `${origin}/..`, `${origin}//`,
    `${origin}?`, `${origin}#`, `${origin}/?token=secret`, 'https://chat.example.test.']) {
    assert.throws(() => normalizeServerOrigin(input), undefined, String(input));
  }
});

test('every server has a stable isolated partition and production keeps its existing session', () => {
  assert.equal(PRESET_SERVERS[0].partition, 'persist:tcn-main');
  assert.equal(serverFromOrigin('https://chat.the-cantina.net/'), PRESET_SERVERS[0]);
  assert.equal(serverFromOrigin('HTTPS://CHAT.EXAMPLE.TEST:443/').partition, serverFromOrigin(origin).partition);
  const servers = [...PRESET_SERVERS, serverFromOrigin(origin), serverFromOrigin('https://chat.example.test:8443')];
  assert.equal(new Set(servers.map(server => server.partition)).size, servers.length);
  assert.equal(new Set(servers.map(server => server.id)).size, servers.length);
  assert.equal(serverFromOrigin(origin).branding, false);
  assert.equal(serverFromOrigin('https://chat.example.test:8443').name, 'chat.example.test:8443');
  assert.ok(Object.isFrozen(PRESET_SERVERS));
  assert.ok(servers.every(Object.isFrozen));
});

test('discovery trusts only selected HTTPS endpoints and WSS gateway, without credentials or redirects', async () => {
  const calls = [];
  const server = await resolveServer(origin, {fetchImpl: async (url, options) => {
    calls.push({url, options});
    return jsonResponse(discovery({api_client: 'https://api.example.test/api', api_public: 'https://public.example.test/api',
      gateway: 'wss://gateway.example.test/socket', media: 'https://media.example.test', static_cdn: 'https://cdn.example.test',
      marketing: 'https://marketing.example.test', admin: 'https://admin.example.test'}));
  }});
  assert.deepEqual(server.requestOrigins, [origin, 'https://api.example.test', 'https://public.example.test', 'https://media.example.test', 'https://cdn.example.test']);
  assert.deepEqual(server.webSocketOrigins, ['wss://gateway.example.test']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${origin}/api/.well-known/fluxer`);
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.method, 'GET');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  assert.ok(Object.isFrozen(server.requestOrigins));
  assert.ok(Object.isFrozen(server.webSocketOrigins));
});

test('only a missing discovery route falls back to the same server root', async () => {
  const urls = [];
  const server = await resolveServer(origin, {fetchImpl: async url => {
    urls.push(url);
    return urls.length === 1 ? new Response(null, {status: 404}) : jsonResponse(discovery());
  }});
  assert.equal(server.origin, origin);
  assert.deepEqual(urls, [`${origin}/api/.well-known/fluxer`, `${origin}/.well-known/fluxer`]);
  for (const status of [301, 302, 307, 308, 401, 403, 500]) {
    let count = 0;
    await assert.rejects(resolveServer(origin, {fetchImpl: async () => {
      count++;
      return new Response(null, {status});
    }}));
    assert.equal(count, 1);
  }
});

test('malformed, insecure, or mismatched discovery fails closed', async () => {
  for (const data of [null, [], {}, {endpoints: []}, {endpoints: {api: `${origin}/api`}},
    {endpoints: {gateway: 'wss://chat.example.test'}}, discovery({api: null}), discovery({api_client: {url: origin}}),
    discovery({api: 'http://chat.example.test/api'}), discovery({gateway: 'https://chat.example.test'}),
    discovery({gateway: 'ws://chat.example.test'}), discovery({gateway: 'wss://user:secret@chat.example.test'}),
    discovery({media: 'https://user:secret@media.example.test'}), discovery({static_cdn: 'http://cdn.example.test'}),
    discovery({webapp: 'https://different.example.test'}), discovery({webapp: 'https://chat.example.test:8443'}),
    discovery({api: `${origin}/api?secret=value`}), discovery({admin: 'javascript:alert(1)'})]) {
    let count = 0;
    await assert.rejects(resolveServer(origin, {fetchImpl: async () => { count++; return jsonResponse(data); }}));
    assert.equal(count, 1);
  }
  await assert.rejects(resolveServer(origin, {fetchImpl: async () => new Response('not JSON')}), /valid JSON/);
  await assert.rejects(resolveServer(origin, {fetchImpl: async () => { throw new Error('network error'); }}), /Could not reach/);
});

test('oversized discovery is rejected with and without content-length', async () => {
  for (const headers of [{}, {'content-length': String(256 * 1024 + 1)}]) {
    await assert.rejects(resolveServer(origin, {fetchImpl: async () => new Response(' '.repeat(256 * 1024 + 1), {headers})}), /too large/);
  }
});

test('unexpected redirected responses are rejected even if a fetch implementation follows them', async () => {
  for (const properties of [{redirected: {value: true}}, {url: {value: 'https://other.example.test/.well-known/fluxer'}}]) {
    const response = jsonResponse(discovery());
    Object.defineProperties(response, properties);
    await assert.rejects(resolveServer(origin, {fetchImpl: async () => response}), /cannot redirect/);
  }
});

test('preferences save only normalized choices and restore selected server', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tcn-servers-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'profile', 'servers.json');
  assert.deepEqual(await loadServerPreferences(file), {selectedOrigin: PRESET_SERVERS[0].origin, customOrigins: []});
  await saveServerPreferences(file, {selectedOrigin: `${origin}/`, customOrigins: [origin, `${origin}/`, PRESET_SERVERS[0].origin]});
  assert.deepEqual(await loadServerPreferences(file), {selectedOrigin: origin, customOrigins: [origin]});
  assert.deepEqual(Object.keys(JSON.parse(await readFile(file, 'utf8'))), ['selectedOrigin', 'customOrigins']);
  await saveServerPreferences(file, {selectedOrigin: PRESET_SERVERS[1].origin, customOrigins: [origin]});
  assert.deepEqual(await loadServerPreferences(file), {selectedOrigin: PRESET_SERVERS[1].origin, customOrigins: [origin]});
  assert.deepEqual(await readdir(join(directory, 'profile')), ['servers.json']);
});

test('invalid preferences never overwrite saved choices; corrupt loads do not repair the file', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tcn-servers-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'servers.json');
  const valid = {selectedOrigin: PRESET_SERVERS[0].origin, customOrigins: []};
  await saveServerPreferences(file, valid);
  const original = await readFile(file, 'utf8');
  for (const state of [{...valid, token: 'must-not-save'}, {...valid, selectedOrigin: origin},
    {...valid, customOrigins: ['https://user:secret@example.test']}, {...valid, customOrigins: Array(33).fill(origin)}]) {
    await assert.rejects(saveServerPreferences(file, state));
    assert.equal(await readFile(file, 'utf8'), original);
  }
  for (const contents of ['broken JSON', JSON.stringify({...valid, token: 'ignored'}), JSON.stringify({...valid, selectedOrigin: 'http://example.test'})]) {
    await writeFile(file, contents);
    assert.deepEqual(await loadServerPreferences(file), valid);
    assert.equal(await readFile(file, 'utf8'), contents);
  }
});

test('storage failures reach the caller and failed atomic replacement leaves no temporary files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tcn-servers-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  const file = join(directory, 'servers.json');
  await mkdir(file);
  await assert.rejects(saveServerPreferences(file, {selectedOrigin: PRESET_SERVERS[0].origin, customOrigins: []}));
  assert.deepEqual(await readdir(directory), ['servers.json']);
  await assert.rejects(loadServerPreferences(file));
});
