// SPDX-License-Identifier: AGPL-3.0-or-later
import {BUILD_CHANNEL} from '@electron/common/BuildChannel';
import {validateReleaseConfig} from './UpdatePolicy.mjs';

declare const __TCN_RELEASE_CONFIG__: unknown;
// Only the native build can set this constant. Server selection and renderer IPC cannot.
export const TCN_RELEASE_CONFIG = typeof __TCN_RELEASE_CONFIG__ === 'undefined' || __TCN_RELEASE_CONFIG__ === null
    ? null : validateReleaseConfig(__TCN_RELEASE_CONFIG__, BUILD_CHANNEL);
