// SPDX-License-Identifier: AGPL-3.0-or-later
import {ipcRenderer} from 'electron';
import type {Server} from './Servers.mjs';
import brandingCss from './branding.css';
import {createTcnBrandingSync} from './Branding';
import {installBundledTcnTheme} from './BundledTheme';

// Runs in upstream's isolated preload. No additional API is exposed to hosted JavaScript.
export async function installLoginSelector(): Promise<void> {
    if (!process.isMainFrame) return;
    let state: {selected: Server; presets: Server[]};
    try { state = await ipcRenderer.invoke('tcn-server-state'); } catch { return; }
    if (location.origin !== state.selected.origin) return;
    void installBundledTcnTheme(state.selected, process.isMainFrame).catch(() => {
        console.warn('TCN optional theme could not be registered; existing themes are unchanged.');
    });
    if (document.readyState === 'loading') await new Promise<void>(resolve => document.addEventListener('DOMContentLoaded', () => resolve(), {once: true}));
    const syncBranding = state.selected.branding ? createTcnBrandingSync() : () => {};
    const host = document.createElement('tcn-server-selector');
    const root = host.attachShadow({mode: 'closed'});
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(`
        :host {display:block; width:100%; max-width:896px; margin:16px auto 0; color:var(--text-primary-muted,#a3b0b6); font:13px/1.5 system-ui,sans-serif; -webkit-app-region:no-drag}
        :host([hidden]),[hidden] {display:none!important}
        form {display:flex; align-items:center; justify-content:center; gap:10px; flex-wrap:wrap; padding:4px 16px}
        input,button {font:inherit; color:var(--text-primary,#edf3f4); background:var(--background-secondary,#111d25); border:1px solid var(--border-color-hover,#33454e); border-radius:6px; padding:6px 10px}
        .server-choice {display:inline-grid; align-items:center; color:var(--text-primary,#edf3f4); line-height:inherit}
        .server-choice select {grid-area:1/1; appearance:none; field-sizing:content; min-width:0; font:inherit; line-height:inherit; color:inherit; background:transparent; border:0; border-radius:2px; padding:0 1.15em 0 0; cursor:pointer}
        .server-choice::after {content:''; grid-area:1/1; justify-self:end; width:.4em; height:.4em; margin-right:.15em; border-right:1.5px solid currentColor; border-bottom:1.5px solid currentColor; transform:translateY(-.12em) rotate(45deg); pointer-events:none}
        option {color:var(--text-primary,#edf3f4); background:var(--background-secondary,#111d25)}
        @supports (appearance:base-select) {
            .server-choice select, .server-choice select::picker(select) {appearance:base-select}
            .server-choice select::picker-icon {display:none}
            .server-choice select::picker(select) {min-width:168px; max-width:calc(100vw - 32px); margin:6px 0; padding:6px; border:1px solid var(--border-color-hover,#33454e); border-radius:10px; background:var(--background-secondary,#111d25); color:var(--text-primary,#edf3f4); box-shadow:0 8px 24px rgb(0 0 0 / 28%); font:13px/1.5 system-ui,sans-serif}
            option {display:flex; align-items:center; gap:16px; min-height:36px; box-sizing:border-box; padding:8px 12px; border-radius:6px; background:transparent; cursor:pointer}
            option + option {margin-top:2px}
            option:checked {background:var(--background-modifier-selected,#2a2316); color:var(--text-primary,#edf3f4)}
            option:hover, option:focus {background:var(--background-modifier-hover,#17262f)}
            option:focus-visible {outline:2px solid var(--focus-primary,#59c8c4); outline-offset:-2px}
            option::checkmark {order:1; margin-left:auto; color:var(--focus-primary,#59c8c4)}
        }
        select:focus-visible,input:focus-visible,button:focus-visible {outline:2px solid var(--focus-primary,#59c8c4); outline-offset:2px}
        button {cursor:pointer} :disabled {opacity:.6; cursor:wait}
        .custom {flex-basis:100%; display:flex; align-items:center; justify-content:center; gap:8px}
        input {width:min(320px,65vw)} .context {max-width:420px;margin:0 auto 8px;padding:0 12px;text-align:center} p {flex-basis:100%; margin:0; text-align:center}
    `);
    root.adoptedStyleSheets = [sheet];
    const form = document.createElement('form');
    const label = document.createElement('label'); label.textContent = 'Server'; label.htmlFor = 'server';
    const select = document.createElement('select'); select.id = 'server';
    const labels: Record<string,string> = {tcn: 'Prod', 'tcn-staging': 'Staging', fluxer: 'Fluxer'};
    for (const server of state.presets) select.add(new Option(labels[server.id] ?? server.name, server.id));
    select.add(new Option('Custom', 'custom'));
    select.value = state.presets.find(server => server.origin === state.selected.origin)?.id ?? 'custom';
    const choice = document.createElement('span'); choice.className = 'server-choice'; choice.append(select);
    const custom = document.createElement('div'); custom.className = 'custom';
    const input = document.createElement('input'); input.type = 'url'; input.placeholder = 'https://chat.example.org'; input.setAttribute('aria-label', 'Custom server URL'); input.maxLength = 2048; input.autocomplete = 'off';
    input.value = select.value === 'custom' ? state.selected.origin : '';
    const connect = document.createElement('button'); connect.type = 'submit'; connect.textContent = 'Connect';
    custom.append(input, connect);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Done'; close.hidden = true;
    const status = document.createElement('p'); status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const context = document.createElement('p'); context.className = 'context'; context.hidden = true;
    form.append(label,choice,close,custom,status);root.append(context,form);
    let forced = false;
    let busy = false;
    const syncCustom = () => { custom.hidden = select.value !== 'custom'; input.required = !custom.hidden; };
    syncCustom();
    async function choose(): Promise<void> {
        if (busy) return;
        const origin = select.value === 'custom' ? input.value.trim() : state.presets.find(server => server.id === select.value)?.origin;
        if (!origin) return;
        busy = true; select.disabled = input.disabled = connect.disabled = true;
        status.textContent = 'Connecting… The client will restart to switch servers.';
        try {
            const result = await ipcRenderer.invoke('tcn-server-select', origin);
            status.textContent = result.ok ? '' : result.error;
        } catch { status.textContent = 'Could not change servers. Please try again.'; }
        finally { busy = false; select.disabled = input.disabled = connect.disabled = false; }
    }
    select.addEventListener('change', event => {
        if (!event.isTrusted) return;
        syncCustom(); status.textContent = '';
        if (select.value === 'custom') {
            // The native picker restores trigger focus after change; focus the URL once it closes.
            setTimeout(() => { if (!custom.hidden) input.focus(); }, 0);
        } else void choose();
    });
    form.addEventListener('submit', event => { event.preventDefault(); if (event.isTrusted) void choose(); });
    close.addEventListener('click', event => { if (event.isTrusted) { forced = false; syncPlacement(); } });
    const pageStyle = new CSSStyleSheet();
    pageStyle.replaceSync(`${state.selected.branding ? brandingCss : ''}
        [data-flx^="auth.flow.instance-selector"] {display:none!important}
        [data-flx="auth.flow.auth-card-container.div"]:has(> tcn-server-selector) {flex-direction:column}
        [data-flx="app.bootstrap-error-screen.error-fallback-container"]:has(> tcn-server-selector) {height:auto;min-height:100dvh;gap:20px;padding:24px 16px;box-sizing:border-box}
        tcn-server-selector[data-floating] {position:fixed; left:50%; bottom:16px; transform:translateX(-50%); width:calc(100% - 32px); z-index:2147483000; padding:4px 0}
    `);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, pageStyle];
    function syncPlacement(): void {
        const auth = document.documentElement.classList.contains('auth-page');
        const card = document.querySelector('[data-flx="auth.flow.auth-card-container.div"]');
        const failure = document.querySelector('[data-flx="app.bootstrap-error-screen.error-fallback-container"]');
        const parent = failure ?? (auth && card ? card : document.body);
        if (host.parentNode !== parent) parent.append(host);
        host.hidden = !auth && !failure && !forced;
        host.toggleAttribute('data-floating', !failure && (!card || !auth));
        context.hidden = !failure;
        if (failure) {
            const selected = labels[state.selected.id] ?? state.selected.name;
            const incompatible = failure.textContent?.includes('missing-bridge-version');
            context.textContent = `Selected server: ${selected}. ${incompatible
                ? 'This server’s web app is incompatible with this desktop version. You can choose another server below.'
                : 'You can choose another server below.'}`;
        }
        syncBranding();
        close.hidden = !forced;
    }
    ipcRenderer.on('tcn-show-server-selector', () => { forced = true; syncPlacement(); select.focus(); });
    // Observe SPA route/layout changes without repeatedly rewriting the page or the selector.
    let scheduled = false;
    new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        queueMicrotask(() => { scheduled = false; syncPlacement(); });
    }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, attributeFilter:['class']});
    syncPlacement();
}
