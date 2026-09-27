# TCN Chat desktop fork

Community patch on Fluxer desktop, AGPL-3.0-or-later.
Upstream: https://github.com/fluxerapp/fluxer
Pinned source: c9754ac11a75295c367c100a1a3f3787b723d809
Application version: see the packaged package.json and its release manifest.

Native main/preload, audio/video/capture, key hooks, tray and settings remain
upstream implementations. TCN owns identity, defaults and desktop server selection.
The approved local symbol is used proportionally on TCN login/error screens.
Server selection remains available on startup failures; the underlying diagnostics
and native checks are preserved. See tcn/PATCHES.md in source.
No official Fluxer update feed, installer migration or protocol ownership is used.

TCN installer releases use independent package identities and a build-time update
policy; changing the selected chat server does not change the update source.
Current compatibility and release acceptance are recorded in the corresponding
source's tcn/PUBLIC.md and version-specific acceptance receipts. A local build
does not establish authenticated feature acceptance or public distribution.
