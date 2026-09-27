// SPDX-License-Identifier: AGPL-3.0-or-later

import {BUILD_CHANNEL} from '@electron/common/BuildChannel';

export const DESKTOP_APP_NAME = BUILD_CHANNEL === 'canary' ? 'TCN Chat Canary' : 'TCN Chat';
export const MACOS_BUNDLE_ID = BUILD_CHANNEL === 'canary' ? 'net.the-cantina.chat.canary' : 'net.the-cantina.chat';
export const LINUX_DESKTOP_ENTRY_ID = BUILD_CHANNEL === 'canary' ? 'tcn-chat-canary' : 'tcn-chat';
export const WINDOWS_SHORTCUT_AUTHOR = 'The Cantina Network';
export const WINDOWS_VELOPACK_ID = BUILD_CHANNEL === 'canary' ? 'tcn_chat_desktop_canary' : 'tcn_chat_desktop';
export const WINDOWS_LEGACY_SQUIRREL_ID = 'tcn_chat_desktop_legacy';
export const WINDOWS_APP_USER_MODEL_ID = BUILD_CHANNEL === 'canary' ? 'TCN.Chat.Canary' : 'TCN.Chat';
export const WINDOWS_LEGACY_APP_USER_MODEL_IDS = [`velopack.${WINDOWS_VELOPACK_ID}`];
export const WINDOWS_TOAST_ACTIVATOR_CLSID =
	BUILD_CHANNEL === 'canary' ? '{72E0949F-8DBA-4684-A597-E562C0670D33}' : '{0FE020EE-15FB-491D-81B5-B8AF80E5B0AF}';
