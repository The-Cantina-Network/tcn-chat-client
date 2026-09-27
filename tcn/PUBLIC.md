# TCN Chat: build and release guide

TCN Chat is a maintained fork of the native Fluxer desktop client. Upstream is
[fluxerapp/fluxer](https://github.com/fluxerapp/fluxer); retain its AGPL-3.0-or-later
license and copyright notices. TCN branding does not imply upstream endorsement.

## Current status

This repository contains source and a manually triggered release workflow.
Actions and public binary/update feeds are currently disabled. There is no public
TCN installer release yet. Local unsigned evaluations do not establish installed,
authenticated or signed release acceptance.

[release-lineage.json](release-lineage.json) is the upstream source authority.
Its null desktop release tag is intentional: the retained upstream commit has
not been mapped to an accepted Fluxer desktop release. Public checks reject that
state. Review a named desktop release before adoption.

## Windows evaluation builds

Use Windows x64, PowerShell 7 and locked workspace dependencies with the native
C++/Rust toolchain. CI targets Node 24, pnpm 11.27.0,
Rust 1.98.1-x86_64-pc-windows-msvc and .NET SDK 10.0.401.
Velopack runtime/CLI are pinned to 1.2.0. The helper does not install a compiler
or change machine defaults.

From the repository root, run pnpm install --frozen-lockfile. Choose a fresh
output directory outside the checkout and an unused three-part SemVer version.
The version argument controls compiled/package metadata; the retained workspace
package version is not a release identifier.

~~~powershell
./tcn/scripts/build-native.ps1 -Version NEW_VERSION -Channel stable -OutputDirectory FRESH_BUILD_DIRECTORY
~~~

This performs the full native build, TypeScript, TCN tests, package inspection
and native-addon loading. Do not bypass native build/preflight checks.
Without explicit release configuration, automatic updates remain disabled.

Package using scripts/releases/pack-windows.ps1 with the same version/channel,
the build's win-unpacked directory, an installed vpk.exe path, a fresh output
directory and explicit -UnsignedTest for local evaluations. Signed distribution
requires the approved signer and all acceptance gates. Keep one version directory
with build/, package/, setup/, reports/ and source/ subdirectories.
Do not upload evaluations as public releases or repack a frozen version.

## Upstream preparation

Follow [PATCHES.md](PATCHES.md). Keep upstream history and capture the maintained
TCN delta as commits. Review an explicit Fluxer desktop release and commit;
never automatically ship the newest upstream commit. Private operator journals,
profiles and generated output do not belong in public Git.

The helper requires clean committed source:

~~~powershell
node tcn/scripts/releases/prepare-upstream.mjs --repository . --tag DESKTOP_TAG --commit EXACT_COMMIT --output FRESH_EXTERNAL_DIRECTORY
~~~

Default mode exports a patch and review plan. Explicit --apply also fetches that
official ref, creates a detached worktree and reapplies the patch. Conflicts
preserve the worktree and an incomplete handoff. No active branch or feed advances.
Update lineage and patch evidence, then verify the source and resulting artifacts.

## Checks and publication

Run the source checks from the repository root:

~~~powershell
node --test tcn/scripts/releases/lineage.test.mjs tcn/scripts/releases/prepare-upstream.test.mjs
./tcn/scripts/releases/test-release-helpers.ps1
node --test fluxer_desktop/src/tcn/*.test.mjs
node --test --test-name-pattern='TCN|Updater Windows' fluxer_desktop/src/main/Updater.test.mjs
node --test fluxer_desktop/src/main/Bootstrap.test.mjs
~~~

Use the full native build helper before candidate acceptance. Public builds add
-RequireReleaseLineage, requiring clean committed source, verified official
desktop lineage and Stable-compatible versions. The pre-build source ZIP/receipt
is embedded and bound to candidate hashes and checked again before publication.

The manual workflow separates candidate building from publication. Enable only
reviewed TCN workflows; inherited upstream workflows are removed from the TCN
integration branch. Configure per-channel build environments, reviewed HTTPS
feed/download URLs, an approved signer and publication environments with required
reviewers. Never embed repository credentials in clients.

Before public binaries or feed advancement, pass exact-byte native/staging checks
and disposable Windows fresh install, upgrade and uninstall. Verify historical
tester migration, authenticated profile preservation and UI-driven restart/
next-launch application through the real HTTPS route. Synthetic SDK fixtures and
bootstrap installers do not establish those acceptance results.

## Installed update behavior

Stable and Canary have distinct package/profile identities. Server selection
cannot change the compiled TCN updater channel. Configured installed clients
check after startup and periodically, download in the background and apply on
explicit restart or the next launch. Unconfigured/unpacked builds do not auto-update.
The first updater-enabled Setup needs manual installation.

Preserve cache/package integrity and official Fluxer isolation. Publish immutable
version assets before advancing channel metadata; verify remote digests and
recovery copies. Use a higher-version forward fix rather than overwriting releases
or silently downgrading feeds.
