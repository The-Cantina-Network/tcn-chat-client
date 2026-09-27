// SPDX-License-Identifier: AGPL-3.0-or-later
import approvedSymbol from '../../build_resources/icons-tcn/symbol.svg';

const logoSources = [
    'auth.flow.auth-card-container.fluxer-logo',
    'app.bootstrap-error-screen.error-fallback-icon',
    'app.error-fallback.fluxer-icon',
].map(value => `[data-flx="${value}"]`).join(',');

// Keep React-owned nodes intact; TCN artwork is isolated from hosted sizing and assets.
export function createTcnBrandingSync(): () => void {
    const replacements = new Map<Element, HTMLElement>();
    return () => {
        for (const [source, replacement] of replacements) {
            if (!source.isConnected) { replacement.remove(); replacements.delete(source); }
        }
        for (const source of document.querySelectorAll(logoSources)) {
            let replacement = replacements.get(source);
            if (!replacement) {
                replacement = document.createElement('tcn-brand-logo');
                replacement.setAttribute('role', 'img');
                const sourceStyle = getComputedStyle(source);
                replacement.style.margin = sourceStyle.margin;
                replacement.setAttribute('aria-label', 'The Cantina Network');
                const shadow = replacement.attachShadow({mode: 'closed'});
                const sheet = new CSSStyleSheet();
                sheet.replaceSync(':host{display:block;flex:none;width:128px;max-width:100%;aspect-ratio:571/422}svg{display:block;width:100%;height:100%}');
                shadow.adoptedStyleSheets = [sheet];
                const svg = new DOMParser().parseFromString(approvedSymbol, 'image/svg+xml').documentElement;
                svg.setAttribute('aria-hidden', 'true');
                shadow.append(document.importNode(svg, true));
                source.setAttribute('data-tcn-brand-source', '');
                replacements.set(source, replacement);
            }
            if (replacement.nextSibling !== source) source.before(replacement);
        }
    };
}
