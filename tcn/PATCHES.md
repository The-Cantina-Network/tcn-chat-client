# Maintained TCN desktop patches

Use [release-lineage.json](release-lineage.json) for the exact upstream dependency
and [PUBLIC.md](PUBLIC.md) for build/release gates. Reapplication alone is not
native, installed, authenticated or distribution acceptance.

| ID | Purpose and source ownership | Reapplication and verification |
| --- | --- | --- |
| D01 | Independent TCN application/protocol/profile identity; common DesktopIdentity, Constants, UserDataPath; tray and builder config. | Preserve TCN profiles/partitions and separate Stable/Canary IDs. Never migrate official Fluxer data or registrations. |
| D02 | Upstream native renderer/preload identity. | Do not spoof bridge versions or hide missing modules. Verify real native startup. |
| D03 | Approved artwork and optional theme; src/tcn/Branding, branding.css, BundledTheme and build_resources/icons-tcn. | Preserve proportional SVG, neutral palettes/defaults and opt-in TCN library behavior. Keep user edits/deletion; verify hosted schema/hydration. |
| D04 | Validated server selection; src/tcn/Servers, ServerState, LoginSelector, ServerDialog and main/preload hooks. | Preserve discovery validation, exact main-frame/origin IPC, atomic settings, keyboard/focus, restart and per-server isolation. |
| D05 | Native trust boundary; main/Window and upstream PrivilegedRendererDocuments. | Keep sandbox, context isolation, selected-origin navigation and native integrations. Test child-frame/foreign-origin denials. |
| D06 | Provenance/update pipeline; Bootstrap, Updater, src/tcn/Release, UpdatePolicy, UpdateCache, build/inspection scripts, tcn/scripts and TCN workflow. | Reapply lineage/preparation, embedding and package/publisher gates together. Retain signed exact-byte staging/installed acceptance, cache integrity and independent HTTPS feeds. |

The approved artwork is fluxer_desktop/build_resources/icons-tcn/symbol.svg,
SHA256 c217b519aa7c269ee30a633b12461c98c5b2ba47eec0e6d0f53fbdfc19d52b36.
Do not redraw, stretch or recolour it. themes/TCN.theme.css starts disabled on TCN
presets and preserves user choices. Hosted main-theme picker additions are a
separate frontend patch/release.

For every adoption, review changed native APIs, IPC, profile formats, theme schema,
packaging and Velopack behavior. Update affected entries, source pin, purpose,
source mapping, reapplication, evidence and limitations. Retire a patch only when
supported upstream behavior preserves its contracts and trust boundaries.
Recovery retains frozen versions and uses reviewed forward fixes.

Private operator journals, infrastructure details and historical prototype files
are excluded from this source import. Public release evidence will accompany
accepted version artifacts; this document makes no release-acceptance claim.
