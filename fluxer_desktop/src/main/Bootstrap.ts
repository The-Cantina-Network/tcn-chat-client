// SPDX-License-Identifier: AGPL-3.0-or-later

import {TCN_COMMUNITY_BUILD} from '@electron/tcn/Build';
import {TCN_RELEASE_CONFIG} from '@electron/tcn/Release';
import {createRequire} from 'node:module';
import path from 'node:path';
import {BUILD_CHANNEL} from '@electron/common/BuildChannel';
import {WINDOWS_VELOPACK_ID} from '@electron/common/DesktopIdentity';
import {validatePendingUpdate, quarantinePendingUpdate} from '@electron/tcn/UpdateCache';
import {repairWindowsShortcuts} from '@electron/main/WindowsShortcuts';

const requireModule = createRequire(import.meta.url);

function canAutoApplyTcnUpdate(): boolean {
    if (!TCN_RELEASE_CONFIG || path.basename(path.dirname(process.execPath)).toLowerCase() !== 'current') return false;
    try {
        const {UpdateManager} = requireModule('velopack') as typeof import('velopack');
        const manager = new UpdateManager(TCN_RELEASE_CONFIG.feedUrl, {
            AllowVersionDowngrade: false, ExplicitChannel: 'win', MaximumDeltasBeforeFallback: 0,
        });
        if (manager.getAppId() !== WINDOWS_VELOPACK_ID || manager.isPortable()) return false;
        const pending = manager.getUpdatePendingRestart();
        if (!pending) return false;
        const packages = path.join(path.dirname(path.dirname(process.execPath)), 'packages');
        try {
            validatePendingUpdate(packages, pending, {packageId: WINDOWS_VELOPACK_ID,
                channel: BUILD_CHANNEL, currentVersion: manager.getCurrentVersion()});
            return true;
        } catch {
            quarantinePendingUpdate(packages, pending, WINDOWS_VELOPACK_ID);
            return false;
        }
    } catch (error) {
        console.warn('[TCN updates] Automatic application deferred:', error);
        return false;
    }
}

if (process.platform === 'win32') {
	const {VelopackApp} = requireModule('velopack') as typeof import('velopack');
	VelopackApp.build()
        .setAutoApplyOnStartup(!TCN_COMMUNITY_BUILD || canAutoApplyTcnUpdate())
		.onAfterInstallFastCallback(() => {
			repairWindowsShortcuts();
		})
		.onAfterUpdateFastCallback(() => {
			repairWindowsShortcuts();
		})
		.onFirstRun(() => {
			repairWindowsShortcuts();
		})
		.onRestarted(() => {
			repairWindowsShortcuts();
		})
		.run();
	repairWindowsShortcuts();
}

await import(new URL('./MainApp.js', import.meta.url).href);
