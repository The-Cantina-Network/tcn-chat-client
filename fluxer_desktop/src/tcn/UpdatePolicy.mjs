// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared by the build and the main-process updater.
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export function parseVersion(value) {
    const match = typeof value === 'string' && SEMVER.exec(value);
    if (!match || match[4]?.split('.').some(part => /^\d+$/.test(part) && part.length > 1 && part[0] === '0')) {
        throw new Error('Invalid desktop release version.');
    }
    return {core: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') ?? []};
}
export function compareReleaseVersions(left, right) {
    const a = parseVersion(left), b = parseVersion(right);
    for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
    if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
    for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i], y = b.pre[i];
        if (x === y) continue;
        if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
        const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
        if (xn && yn) return BigInt(x) < BigInt(y) ? -1 : 1;
        if (xn !== yn) return xn ? -1 : 1;
        return x < y ? -1 : 1;
    }
    return 0;
}
export function validateReleaseConfig(value, expectedChannel) {
    if (!value || value.schema !== 'tcn-desktop-release/v1' ||
        !['stable', 'canary'].includes(value.channel) || value.channel !== expectedChannel) {
        throw new Error('Release configuration must match the desktop build channel.');
    }
    function https(value) {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
            url.port || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') ||
            url.hostname === 'fluxer.app' || url.hostname.endsWith('.fluxer.app') ||
            url.hostname === 'fluxer.com' || url.hostname.endsWith('.fluxer.com') ||
            !url.hostname.includes('.') || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) {
            throw new Error('TCN release URLs must be dedicated public HTTPS addresses.');
        }
        return url.href.replace(/\/$/, '');
    }
    return Object.freeze({schema: value.schema, channel: value.channel,
        feedUrl: https(value.feedUrl), downloadPageUrl: https(value.downloadPageUrl)});
}
export function validateReleaseAsset(update, packageId, currentVersion, channel, source = 'feed') {
    const asset = update?.TargetFullRelease ?? update;
    if (!asset || asset.PackageId !== packageId || asset.Type !== 'Full' ||
        !/^[a-zA-Z0-9_.-]+\.nupkg$/.test(asset.FileName ?? '') ||
        (source !== 'downloaded' && !/^[a-fA-F0-9]{64}$/.test(asset.SHA256 ?? '')) ||
        !Number.isSafeInteger(Number(asset.Size)) || Number(asset.Size) <= 0 ||
        update.IsDowngrade || compareReleaseVersions(asset.Version, currentVersion) <= 0 ||
        (channel === 'stable' && parseVersion(asset.Version).pre.length)) {
        throw new Error('The desktop update does not match this installation or release channel.');
    }
    return asset;
}
