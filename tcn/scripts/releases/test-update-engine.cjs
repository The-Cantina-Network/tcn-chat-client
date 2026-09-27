// SPDX-License-Identifier: AGPL-3.0-or-later
// Run with ELECTRON_RUN_AS_NODE=1 using the exact candidate's packaged executable.
// Custom locator paths exist only in this external test harness. No installation,
// Update.exe execution, VelopackApp.run(), profile access or update application occurs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const originalFs = require('original-fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const {createRequire} = require('node:module');

function parseArgs() {
    const args = new Map();
    const valid = new Set(['--candidate', '--output', '--current-version']);
    for (let i = 2; i < process.argv.length; i += 2) {
        const name = process.argv[i];
        assert.ok(valid.has(name) && !args.has(name) && process.argv[i + 1], 'Usage: test-update-engine.cjs --candidate DIR --output FRESH_DIR --current-version OLDER_VERSION');
        args.set(name, process.argv[i + 1]);
    }
    assert.equal(args.size, valid.size, 'All arguments are required.');
    return args;
}

function child(root, name) {
    assert.ok(name && !path.isAbsolute(name) && !name.split(/[\\/]/).includes('..') && !name.includes(':'), 'Unsafe relative path');
    const result = path.resolve(root, name);
    assert.ok(result.toLowerCase().startsWith(path.resolve(root).toLowerCase() + path.sep), 'Path escapes fixture root');
    return result;
}

async function digest(file, implementation = fs) {
    const hash = crypto.createHash('sha256');
    for await (const bytes of implementation.createReadStream(file)) hash.update(bytes);
    return hash.digest('hex');
}

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'}); }

async function main() {
    assert.equal(process.platform, 'win32', 'Windows native updater required');
    assert.ok(process.versions.electron && process.env.ELECTRON_RUN_AS_NODE === '1', 'Run under packaged Electron in Node mode');
    const args = parseArgs();
    const candidateRoot = path.resolve(args.get('--candidate'));
    const output = path.resolve(args.get('--output'));
    assert.ok(!fs.existsSync(output), 'Output must be a fresh fixture directory');
    assert.ok(!output.toLowerCase().startsWith(candidateRoot.toLowerCase() + path.sep), 'Do not write fixtures into a frozen candidate');
    const currentVersion = args.get('--current-version');
    const candidatePath = child(candidateRoot, 'candidate.json');
    const candidate = readJson(candidatePath);
    assert.equal(candidate.schema, 'tcn-desktop-candidate/v1');
    assert.equal(candidate.velopackVersion, '1.2.0');
    assert.equal(candidate.architecture, 'x64');
    assert.ok(['stable', 'canary'].includes(candidate.channel));
    const packageId = candidate.channel === 'canary' ? 'tcn_chat_desktop_canary' : 'tcn_chat_desktop';
    const mainExe = candidate.channel === 'canary' ? 'TCN Chat Canary.exe' : 'TCN Chat.exe';
    assert.equal(candidate.packageId, packageId);
    assert.match(currentVersion, /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/);
    assert.notEqual(currentVersion, candidate.version, 'Fixture current version must be older than target');
    const releases = child(candidateRoot, 'releases');
    for (const artifact of candidate.artifacts) {
        const artifactPath = child(releases, artifact.name);
        assert.equal(fs.statSync(artifactPath).size, artifact.size);
        assert.equal(await digest(artifactPath), artifact.sha256);
    }
    const feed = readJson(child(releases, 'releases.win.json'));
    assert.equal(feed.Assets.length, 1);
    const asset = feed.Assets[0];
    assert.equal(asset.PackageId, packageId);
    assert.equal(asset.Version, candidate.version);
    assert.equal(asset.Type, 'Full');
    assert.equal(asset.SHA256.toLowerCase(), candidate.nupkgSha256);
    assert.equal(asset.FileName, path.basename(asset.FileName));
    const nupkg = child(releases, asset.FileName);
    assert.equal(await digest(nupkg), candidate.nupkgSha256);
    const packageRoot = path.join(path.dirname(process.execPath), 'resources', 'app.asar');
    const runtimeRequire = createRequire(path.join(packageRoot, 'package.json'));
    const metadata = runtimeRequire('./package.json');
    assert.equal(metadata.name, packageId);
    assert.equal(metadata.version, candidate.version);
    assert.equal(await digest(packageRoot, originalFs), await digest(child(candidateRoot, 'verified-payload/resources/app.asar'), originalFs), 'Executable must load the exact candidate ASAR');
    assert.equal(path.basename(process.execPath), mainExe);
    assert.equal(await digest(process.execPath), await digest(child(candidateRoot, `verified-payload/${mainExe}`)), 'Run with the actual packaged candidate executable');
    const {UpdateManager} = runtimeRequire('velopack');
    const updateSource = child(candidateRoot, 'verified-payload/Squirrel.exe');
    assert.ok(fs.statSync(updateSource).isFile());
    // Even accidental future calls through this harness cannot request application.
    UpdateManager.prototype.waitExitThenApplyUpdate = () => { throw new Error('Applying updates is forbidden in this fixture harness.'); };
    fs.mkdirSync(output, {recursive: true});
    const receipt = {
        schema: 'tcn-desktop-update-engine/v1', channel: candidate.channel, version: candidate.version,
        currentVersion, packageId, nupkgSha256: candidate.nupkgSha256, candidateSha256: await digest(candidatePath),
        electron: process.versions.electron, arch: process.arch, passed: false, cases: [],
        customLocator: true, updaterExecuted: false, registryOrUserProfileTouched: false,
        limitation: 'Real native SDK check/download against a loopback fixture; not an installed app, public CDN or application/restart acceptance.'
    };
    const requests = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://fixture.invalid');
        const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
        const scenario = parts[0];
        const name = parts[1];
        requests.push({scenario, name});
        if (parts.length !== 2 || !['good', 'checksum', 'corrupt', 'unavailable'].includes(scenario)) { response.writeHead(404).end(); return; }
        if (name === 'releases.win.json') {
            const responseFeed = structuredClone(feed);
            if (scenario === 'checksum') { responseFeed.Assets[0].SHA256 = '0'.repeat(64); responseFeed.Assets[0].SHA1 = '0'.repeat(40); }
            const data = Buffer.from(JSON.stringify(responseFeed));
            response.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': data.length});
            response.end(data);
            return;
        }
        if (name !== asset.FileName || scenario === 'unavailable') { response.writeHead(404).end(); return; }
        if (scenario === 'corrupt') {
            const data = Buffer.from('deliberately invalid update fixture');
            response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': data.length});
            response.end(data);
            return;
        }
        response.writeHead(200, {'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(nupkg).size});
        const stream = fs.createReadStream(nupkg);
        stream.on('error', error => response.destroy(error));
        stream.pipe(response);
    });
    server.requestTimeout = 30000;
    const timeout = setTimeout(() => { receipt.error = 'Update engine fixture timed out'; fs.writeFileSync(child(output, 'failure.json'), JSON.stringify(receipt, null, 2)); process.exit(1); }, 180000);
    try {
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        const port = server.address().port;
        for (const scenario of ['good', 'checksum', 'corrupt', 'unavailable']) {
            const fixture = child(output, scenario);
            const current = child(fixture, 'current');
            const packages = child(fixture, 'packages');
            fs.mkdirSync(current, {recursive: true});
            fs.mkdirSync(packages);
            const updater = child(fixture, 'Update.exe');
            fs.copyFileSync(updateSource, updater, fs.constants.COPYFILE_EXCL);
            const manifest = child(current, 'sq.version');
            fs.writeFileSync(manifest, `<?xml version="1.0" encoding="utf-8"?><package><metadata><id>${packageId}</id><version>${currentVersion}</version><title>${mainExe.slice(0, -4)}</title><authors>The Cantina Network</authors><mainExe>${mainExe}</mainExe><os>win</os><machineArchitecture>x64</machineArchitecture><channel>win</channel></metadata></package>`, {flag: 'wx'});
            const locator = {RootAppDir: fixture, UpdateExePath: updater, PackagesDir: packages, ManifestPath: manifest, CurrentBinaryDir: current, IsPortable: false};
            const manager = new UpdateManager(`http://127.0.0.1:${port}/${scenario}`, {AllowVersionDowngrade: false, ExplicitChannel: 'win', MaximumDeltasBeforeFallback: 0}, locator);
            assert.equal(manager.getAppId(), packageId);
            assert.equal(manager.getCurrentVersion(), currentVersion);
            assert.equal(manager.isPortable(), false);
            assert.equal(manager.getUpdatePendingRestart(), null);
            const update = await manager.checkForUpdatesAsync();
            assert.ok(update, 'Current fixture version must be strictly older than candidate');
            assert.equal(update.IsDowngrade, false);
            assert.equal(update.BaseRelease, null, 'Download-only harness forbids delta patch execution');
            assert.deepEqual(update.DeltasToTarget, [], 'Download-only harness forbids delta patch execution');
            assert.equal(update.TargetFullRelease.Version, candidate.version);
            assert.equal(update.TargetFullRelease.PackageId, packageId);
            assert.equal(update.TargetFullRelease.FileName, asset.FileName);
            const progress = [];
            let failure = null;
            try { await manager.downloadUpdateAsync(update, value => { assert.ok(Number.isFinite(value) && value >= 0 && value <= 100); progress.push(value); }); }
            catch (error) { failure = String(error); }
            if (scenario === 'good') {
                assert.equal(failure, null);
                assert.ok(progress.length > 0, 'Native download progress callback must run');
                const downloaded = child(packages, asset.FileName);
                assert.equal(await digest(downloaded), candidate.nupkgSha256);
                assert.equal(fs.statSync(downloaded).size, asset.Size);
                const pending = manager.getUpdatePendingRestart();
                assert.ok(pending);
                assert.equal(pending.PackageId, packageId);
                assert.equal(pending.Version, candidate.version);
                assert.equal(pending.FileName, asset.FileName);
                // SDK 1.2.0's filesystem-derived pending asset omits checksums.
                // Record the actual contract while independently hashing its bytes.
                receipt.cases.push({scenario, passed: true, progressEvents: progress.length, maximumProgress: Math.max(...progress), downloadedSha256: await digest(downloaded), pending});
            } else {
                assert.ok(failure, `${scenario} must reject the update download`);
                assert.equal(manager.getUpdatePendingRestart(), null, 'Rejected bytes must never be pending for restart');
                receipt.cases.push({scenario, passed: true, rejected: true, error: failure, progressEvents: progress.length});
            }
            assert.equal(await digest(updater), await digest(updateSource));
            assert.equal(manager.getCurrentVersion(), currentVersion, 'Harness must not apply any package');
        }
        assert.ok(requests.some(request => request.scenario === 'good' && request.name === asset.FileName));
        receipt.requests = requests;
        receipt.passed = true;
        receipt.completedUtc = new Date().toISOString();
        writeJson(child(output, 'receipt.json'), receipt);
        console.log(`Native Velopack check/download/pending and three failed-download cases passed for ${candidate.channel} ${candidate.version}.`);
    } catch (error) {
        receipt.error = error.stack || String(error);
        writeJson(child(output, 'failure.json'), receipt);
        throw error;
    } finally {
        clearTimeout(timeout);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
