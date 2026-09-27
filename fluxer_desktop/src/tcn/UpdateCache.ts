// SPDX-License-Identifier: AGPL-3.0-or-later
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {validateReleaseAsset} from './UpdatePolicy.mjs';

export interface UpdateCachePolicy {
    packageId: string;
    channel: 'stable' | 'canary';
    currentVersion: string;
}
export interface CachedUpdateAsset {
    PackageId: string;
    Version: string;
    Type: 'Full';
    FileName: string;
    SHA256: string;
    Size: number;
}
export interface VerifiedUpdateReceipt {
    schema: 'tcn-verified-update/v1';
    channel: 'stable' | 'canary';
    asset: CachedUpdateAsset;
}

export const VERIFIED_UPDATE_RECEIPT = 'tcn-verified-update.json';
const MAX_RECEIPT_BYTES = 16 * 1024;
const HASH_BUFFER_BYTES = 1024 * 1024;

function checkedRoot(packagesRoot: string): string {
    if (!path.isAbsolute(packagesRoot)) throw new Error('The update cache path must be absolute.');
    const root = path.resolve(packagesRoot);
    const info = fs.lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('The update cache must be a real directory.');
    return fs.realpathSync(root);
}

function checkedAsset(value: unknown, expectedPackageId: string): {PackageId: string; FileName: string; Type: 'Full'} {
    const asset = value as Partial<CachedUpdateAsset> | null;
    if (!asset || typeof expectedPackageId !== 'string' || !expectedPackageId ||
        asset.PackageId !== expectedPackageId || asset.Type !== 'Full' ||
        typeof asset.FileName !== 'string' || asset.FileName.length > 240 ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.nupkg$/.test(asset.FileName)) {
        throw new Error('The cached update identity or filename is invalid.');
    }
    return {PackageId: expectedPackageId, FileName: asset.FileName, Type: 'Full'};
}

function regularFile(file: string): fs.Stats {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('The update cache entry must be a regular file.');
    return info;
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
    return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
        left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function verifyBytes(root: string, asset: CachedUpdateAsset): void {
    const file = path.join(root, asset.FileName);
    const initial = regularFile(file);
    if (initial.size !== asset.Size) throw new Error('The cached update size does not match the verified release.');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
        if (!sameFile(initial, fs.fstatSync(fd))) throw new Error('The cached update changed during verification.');
        const hash = createHash('sha256');
        const buffer = Buffer.allocUnsafe(HASH_BUFFER_BYTES);
        let total = 0;
        let read = 0;
        while ((read = fs.readSync(fd, buffer, 0, buffer.length, null)) !== 0) {
            total += read;
            if (total > asset.Size) throw new Error('The cached update changed during verification.');
            hash.update(buffer.subarray(0, read));
        }
        if (total !== asset.Size || !sameFile(initial, fs.fstatSync(fd)) || !sameFile(initial, regularFile(file))) {
            throw new Error('The cached update changed during verification.');
        }
        if (hash.digest('hex') !== asset.SHA256.toLowerCase()) {
            throw new Error('The cached update checksum does not match the verified release.');
        }
    } finally {
        fs.closeSync(fd);
    }
}

function minimalAsset(asset: ReturnType<typeof validateReleaseAsset>): CachedUpdateAsset {
    return {PackageId: asset.PackageId, Version: asset.Version, Type: 'Full', FileName: asset.FileName,
        SHA256: asset.SHA256.toLowerCase(), Size: Number(asset.Size)};
}

function readReceipt(root: string): VerifiedUpdateReceipt {
    const file = path.join(root, VERIFIED_UPDATE_RECEIPT);
    const info = regularFile(file);
    if (info.size > MAX_RECEIPT_BYTES) throw new Error('The verified update receipt is too large.');
    const receipt = JSON.parse(fs.readFileSync(file, 'utf8')) as VerifiedUpdateReceipt;
    if (!receipt || receipt.schema !== 'tcn-verified-update/v1' || !receipt.asset) {
        throw new Error('The verified update receipt is invalid.');
    }
    return receipt;
}

// Call only after downloadUpdateAsync succeeds. Velopack may reuse an existing
// .nupkg without hashing it again, so the actual cache bytes are checked here.
export function writeVerifiedUpdate(packagesRoot: string, update: unknown, policy: UpdateCachePolicy): VerifiedUpdateReceipt {
    const asset = minimalAsset(validateReleaseAsset(update, policy.packageId, policy.currentVersion, policy.channel));
    checkedAsset(asset, policy.packageId);
    const root = checkedRoot(packagesRoot);
    verifyBytes(root, asset);
    const receipt: VerifiedUpdateReceipt = {schema: 'tcn-verified-update/v1', channel: policy.channel, asset};
    const bytes = JSON.stringify(receipt);
    const destination = path.join(root, VERIFIED_UPDATE_RECEIPT);
    const temporary = path.join(root, `${VERIFIED_UPDATE_RECEIPT}.${randomUUID()}.tmp`);
    let created = false;
    try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        created = true;
        try {
            fs.writeFileSync(fd, bytes, 'utf8');
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, destination);
        created = false;
        if (fs.readFileSync(destination, 'utf8') !== bytes) throw new Error('The verified update receipt could not be confirmed.');
        return receipt;
    } finally {
        if (created) fs.unlinkSync(temporary);
    }
}

// SDK pending metadata intentionally has no digest; match it to the receipt
// originally verified from the release feed, then recheck the on-disk bytes.
export function validatePendingUpdate(packagesRoot: string, pending: unknown, policy: UpdateCachePolicy): VerifiedUpdateReceipt {
    const local = validateReleaseAsset(pending, policy.packageId, policy.currentVersion, policy.channel, 'downloaded');
    checkedAsset(local, policy.packageId);
    const root = checkedRoot(packagesRoot);
    const receipt = readReceipt(root);
    if (receipt.channel !== policy.channel) throw new Error('The cached update belongs to another release channel.');
    const recorded = minimalAsset(validateReleaseAsset(receipt.asset, policy.packageId, policy.currentVersion, policy.channel));
    checkedAsset(recorded, policy.packageId);
    if (recorded.PackageId !== local.PackageId || recorded.Version !== local.Version ||
        recorded.FileName !== local.FileName || recorded.Type !== local.Type || recorded.Size !== Number(local.Size)) {
        throw new Error('The pending update does not match its verified receipt.');
    }
    verifyBytes(root, recorded);
    return {schema: 'tcn-verified-update/v1', channel: policy.channel, asset: recorded};
}

// Keep invalid package bytes for diagnosis, but remove their .nupkg extension so
// Velopack cannot auto-apply or reuse them. Never enumerate or delete the cache.
export function quarantinePendingUpdate(packagesRoot: string, pending: unknown, expectedPackageId: string): string | null {
    const asset = checkedAsset(pending, expectedPackageId);
    const root = checkedRoot(packagesRoot);
    const source = path.join(root, asset.FileName);
    try {
        regularFile(source);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
    const destination = path.join(root, `${asset.FileName}.${randomUUID()}.invalid`);
    fs.renameSync(source, destination);
    return destination;
}
