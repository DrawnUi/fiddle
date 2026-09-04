// DrawnUI Fiddle — Monaco C# member completion backed by in-browser Roslyn.
// Registered once when the fiddle editor inits. The `enabled` flag lets the page
// turn IntelliSense off instantly (no C# round-trip) if it feels laggy.
window.fiddleIntelliSense = { enabled: true, autoCompile: true, dotnet: null, registered: false };

// Draggable vertical splitter between the code and canvas panes. Updates the
// --fiddle-split CSS var (code pane width %) live while dragging. Clamped so both
// panes always stay visible; min-width:0 on the panes prevents overflow.
window.initFiddleSplitter = function () {
    const split = document.querySelector('.fiddle-split');
    const divider = split && split.querySelector('.fiddle-divider');
    if (!split || !divider || divider._wired) return;
    divider._wired = true;

    let dragging = false;
    divider.addEventListener('pointerdown', function (e) {
        dragging = true;
        divider.classList.add('dragging');
        try { divider.setPointerCapture(e.pointerId); } catch { }
        e.preventDefault();
    });
    divider.addEventListener('pointermove', function (e) {
        if (!dragging) return;
        const rect = split.getBoundingClientRect();
        if (rect.width <= 0) return;
        let pct = ((e.clientX - rect.left) / rect.width) * 100;
        pct = Math.max(20, Math.min(80, pct));
        split.style.setProperty('--fiddle-split', pct + '%');
    });
    const end = function (e) {
        if (!dragging) return;
        dragging = false;
        divider.classList.remove('dragging');
        try { divider.releasePointerCapture(e.pointerId); } catch { }
    };
    divider.addEventListener('pointerup', end);
    divider.addEventListener('pointercancel', end);

    // Horizontal handle under the split pane — drags the pane HEIGHT. Monaco
    // (automaticLayout) and the DrawnUI canvas (ResizeObserver) adapt on their own.
    const dividerH = document.querySelector('.fiddle-divider-h');
    if (dividerH && !dividerH._wired) {
        dividerH._wired = true;
        let draggingH = false;
        dividerH.addEventListener('pointerdown', function (e) {
            draggingH = true;
            dividerH.classList.add('dragging');
            try { dividerH.setPointerCapture(e.pointerId); } catch { }
            e.preventDefault();
        });
        dividerH.addEventListener('pointermove', function (e) {
            if (!draggingH) return;
            const rect = split.getBoundingClientRect();
            let h = e.clientY - rect.top;
            h = Math.max(260, Math.min(Math.round(window.innerHeight * 0.95), h));
            split.style.height = h + 'px';
        });
        const endH = function (e) {
            if (!draggingH) return;
            draggingH = false;
            dividerH.classList.remove('dragging');
            try { dividerH.releasePointerCapture(e.pointerId); } catch { }
        };
        dividerH.addEventListener('pointerup', endH);
        dividerH.addEventListener('pointercancel', endH);
    }
};

window.setFiddleAutoCompile = function (on) {
    window.fiddleIntelliSense.autoCompile = !!on;
};

// Inline color swatches + picker for Color.FromHex("...") / Color.Parse("...") literals.
// Monaco shows a swatch before each match; clicking it opens the built-in picker and the
// chosen color is written back into the code (triggering autocompile).
window.fiddleRegisterColorPicker = function () {
    if (window._fiddleColorPicker || typeof monaco === 'undefined') return;
    window._fiddleColorPicker = true;

    function parseHex(hex) {
        let x = hex.slice(1);
        if (x.length === 3 || x.length === 4) x = x.split('').map(c => c + c).join('');
        if (x.length === 6) x = 'FF' + x;
        if (x.length !== 8) return null;
        const n = parseInt(x, 16);
        if (Number.isNaN(n)) return null;
        return {
            alpha: ((n >>> 24) & 255) / 255,
            red: ((n >>> 16) & 255) / 255,
            green: ((n >>> 8) & 255) / 255,
            blue: (n & 255) / 255,
        };
    }

    monaco.languages.registerColorProvider('csharp', {
        provideDocumentColors(model) {
            const out = [];
            const re = /Color\.(?:FromHex|Parse)\(\s*"(#[0-9a-fA-F]{3,8})"\s*\)/g;
            const text = model.getValue();
            let m;
            while ((m = re.exec(text))) {
                const hex = m[1];
                const color = parseHex(hex);
                if (!color) continue;
                const start = m.index + m[0].indexOf(hex);
                const s = model.getPositionAt(start);
                const e = model.getPositionAt(start + hex.length);
                out.push({
                    color,
                    range: {
                        startLineNumber: s.lineNumber, startColumn: s.column,
                        endLineNumber: e.lineNumber, endColumn: e.column,
                    },
                });
            }
            return out;
        },
        provideColorPresentations(model, info) {
            const h = v => Math.round(v * 255).toString(16).padStart(2, '0').toUpperCase();
            const c = info.color;
            const hex = c.alpha < 1
                ? '#' + h(c.alpha) + h(c.red) + h(c.green) + h(c.blue) // #AARRGGBB (MAUI order)
                : '#' + h(c.red) + h(c.green) + h(c.blue);
            return [{ label: hex }];
        },
    });
};

// Shareable links: code is deflate-compressed and base64url-encoded into the URL hash.
// fiddleShareEncode returns the full share URL; fiddleShareDecode reads the current
// location hash and returns the decoded code, or null when there is none.
window.fiddleShareEncode = async function (code) {
    const bytes = new TextEncoder().encode(code);
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    const buf = await new Response(stream).arrayBuffer();
    let bin = '';
    new Uint8Array(buf).forEach(b => bin += String.fromCharCode(b));
    const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return location.origin + '/#code=' + b64;
};
// Short share links via the fiddle-share Cloudflare Worker (routes on fiddle.drawnui.net).
// Absolute endpoint so shares from localhost dev also produce real short links. A signed-in
// session (FiddleSession -> fiddleSetApi) reroutes to the worker the account talks to (on
// localhost: wrangler dev) and attaches the session so shares land in the user's library.
const FIDDLE_API_PROD = 'https://fiddle.drawnui.net';
window.fiddleSetApi = function (base) { window.fiddleApiBase = base || undefined; };
// Until the app calls fiddleSetApi (it does that on start, but a shared link is decoded around the
// same moment), fall back the same way the app would: local dev talks to the wrangler worker.
function fiddleApiDefault() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1' ? 'http://localhost:8787' : FIDDLE_API_PROD;
}
function fiddleShareApi() { return (window.fiddleApiBase || fiddleApiDefault()) + '/api/share'; }
function fiddleAuthHeaders() {
    try { const t = localStorage.getItem('fiddle.session'); return t ? { 'Authorization': 'Bearer ' + t } : {}; }
    catch { return {}; }
}

// POST code (+ optional base64 PNG thumbnail for the OG preview) -> short URL like
// https://fiddle.drawnui.net/f/aX3kQ9b2. Throws on failure; caller falls back to #code=.
// kind: 'fiddle' (editor share) | 'app' (Export -> Web app) — which library list a signed-in user sees it in.
// nosave: do not add to the signed-in user's library (admin preset seeding).
window.fiddleShareShort = async function (code, pngBase64, bg, kind, nosave, desc, tags, assetsBase64) {
    const r = await fetch(fiddleShareApi(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...fiddleAuthHeaders() },
        body: JSON.stringify({ code: code, png: pngBase64 || undefined, bg: bg || undefined, kind: kind || undefined, nosave: nosave || undefined, desc: desc || undefined, tags: tags || undefined, assets: assetsBase64 || undefined }),
    });
    if (!r.ok) throw new Error('share api ' + r.status);
    return (await r.json()).url;
};

// "Run Web App" export: open the created play link in a new tab. Called only AFTER the
// share entry exists (no blank pre-opened tabs). Returns false when a popup blocker
// intervened so the UI can fall back to a clickable link.
window.fiddleOpenTab = function (url) {
    try {
        const w = window.open(url, '_blank');
        return !!w;
    } catch {
        return false;
    }
};

// Player badge: sandboxed host iframes may block window.open (no allow-popups).
// Fall back to navigating our own frame — sandbox always permits self-navigation.
// Wired via delegation because Blazor strips inline on* attributes from markup.
window.fiddleBadgeOpen = function (url) {
    if (window.fiddleOpenTab(url)) return false;
    location.href = url;
    return false;
};
document.addEventListener('click', function (e) {
    const a = e.target && e.target.closest ? e.target.closest('.fiddle-player-badge') : null;
    if (!a) return;
    e.preventDefault();
    window.fiddleBadgeOpen(a.href);
});

// Keyboard ownership. DrawnUI listens for keys at window level, so the canvas always gets
// them — but Monaco keeps DOM focus and consumes the same keys (arrows move the caret, space
// types). Clicking the canvas pane moves DOM focus onto it (tabindex=0): Monaco is blurred,
// and while the pane owns focus the browser's scroll/tab defaults for game keys are suppressed.
// Clicking back into the editor restores normal typing. Delegated: the pane is Blazor-rendered.
(function () {
    const pane = (t) => t && t.closest && t.closest('.fiddle-canvas');
    document.addEventListener('pointerdown', (e) => {
        const p = pane(e.target);
        if (p && document.activeElement !== p) p.focus({ preventScroll: true });
    }, true);
    const swallow = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' ', 'Spacebar', 'PageUp', 'PageDown', 'Home', 'End', 'Tab']);
    document.addEventListener('keydown', (e) => {
        if (!e.ctrlKey && !e.metaKey && !e.altKey && swallow.has(e.key) && pane(document.activeElement) === document.activeElement) e.preventDefault();
    });
})();

// Live canvas pane CSS size, used to shape the iframe embed's aspect ratio.
window.fiddleCanvasSize = function () {
    const c = document.querySelector('.fiddle-canvas');
    if (!c) return [0, 0];
    const r = c.getBoundingClientRect();
    return [Math.round(r.width), Math.round(r.height)];
};

// Player mode: canvas-only standalone run UI. The worker serves the app directly at
// /p/{id} (address bar keeps the OG-carrying link); legacy #play={id} hash still works.
window.fiddlePlayId = function () {
    const p = location.pathname.match(/\/p\/([A-Za-z0-9]{6,16})$/);
    if (p) return p[1];
    // /d/{id}: a draft, run the same way. Ids are 22 chars where a published one is 6-16, and the
    // worker answers /api/share/{id} for both, so nothing else here has to know the difference.
    const d = location.pathname.match(/\/d\/([A-Za-z0-9]{22})$/);
    if (d) return d[1];
    const m = location.hash.match(/#play=([A-Za-z0-9]{6,22})/);
    return m ? m[1] : null;
};

// Fetch shared fiddle by short id (player boot and #id= boot both use this).
// Returns { code, bg } — bg is the canvas background stored with the share, or null.
// Files the author shared with a fiddle, as base64 of the stored zip, or null when it has none.
window.fiddleFetchAssets = async function (id) {
    try {
        const r = await fetch(fiddleShareApi().replace('/api/share', '') + '/f/' + id + '/assets');
        // 204 = this fiddle simply has no resource bundle, which is the normal case.
        if (!r.ok || r.status === 204) return null;
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (bytes.length === 0) return null;
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000)
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return btoa(s);
    } catch {
        return null;
    }
};

window.fiddleFetchShared = async function (id) {
    try {
        const r = await fetch(fiddleShareApi() + '/' + id);
        if (!r.ok) return null;
        const d = r.headers.get('X-Fiddle-Desc');
        let desc = null; try { desc = d ? decodeURIComponent(d) : null; } catch { }
        // id travels with the payload: the editor needs it to offer "Update thumbnail" on the
        // very fiddle that was opened (the share id is the hash of this exact code).
        return { id, code: await r.text(), bg: r.headers.get('X-Fiddle-Bg'), desc, tags: r.headers.get('X-Fiddle-Tags') };
    } catch {
        return null;
    }
};

// Returns { code, bg } for a shared link in the current URL, or null.
window.fiddleShareDecode = async function () {
    // Short link landing redirected here as #id= — fetch from the share API.
    const idm = location.hash.match(/#id=([A-Za-z0-9]{6,16})/);
    if (idm) return await window.fiddleFetchShared(idm[1]);
    const m = location.hash.match(/#code=([A-Za-z0-9\-_]+)/);
    if (!m) return null;
    try {
        const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const buf = await new Response(stream).arrayBuffer();
        return { code: new TextDecoder().decode(buf), bg: null };
    } catch {
        return null;
    }
};

// Drop the #code= hash from the address bar without reloading (leaving single-fiddle mode).
window.fiddleClearHash = function () {
    history.replaceState(null, '', location.pathname + location.search);
};

// Reflect the selected preset in the address bar (/app/<slug>) without a reload/reroute.
window.fiddleSetPath = function (slug) {
    history.pushState(null, '', new URL('app/' + (slug || ''), document.baseURI).href);
};

// Landing feed injected by the worker into index.html (copied at parse time, see index.html)
// — the Blazor landing hydrates from it instead of blanking the grid while it fetches.
window.fiddleLandingFeed = function () { return window.__fxFeed || null; };

// "New version available" pill: the running page keeps its publish number; index.html is
// re-fetched uncached after boot and every 10 minutes. Newer number -> offer a reload
// (never automatic: the user may be mid-edit).
window.fiddleCheckVersion = async function () {
    if (window.fiddleIsPlayer || document.getElementById('fx-update')) return;
    const mine = Number(window.fiddlePublishNumber && window.fiddlePublishNumber());
    if (!mine) return;
    try {
        const r = await fetch(new URL('index.html', document.baseURI).href, { cache: 'no-store' });
        const m = (await r.text()).match(/fiddle-intellisense\.js\?v=(\d+)/);
        if (!m || Number(m[1]) <= mine) return;
        // Centred dialog over a dimmed page — a pill in a corner went unnoticed. Still never
        // reloads by itself (the visitor may be mid-edit): "Later" dismisses, the periodic check
        // brings it back.
        const font = '"Exo 2","Segoe UI",Roboto,sans-serif';
        const back = document.createElement('div');
        back.id = 'fx-update';
        back.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(2,4,10,.72);backdrop-filter:blur(3px)';
        const card = document.createElement('div');
        card.style.cssText = 'max-width:380px;margin:16px;padding:22px 24px;border-radius:16px;border:1px solid rgba(103,232,249,.35);background:#0b0f1a;box-shadow:0 24px 70px rgba(0,0,0,.6);text-align:center;font-family:' + font;
        card.innerHTML = '<div style="font:800 17px ' + font + ';color:#e6edf6;margin-bottom:6px">New version available</div>'
            + '<div style="font:400 13px ' + font + ';color:#8b98ab;line-height:1.5">Publish ' + m[1] + ' is out — you are running ' + mine + '.<br>Reload to get it. Unsaved editor changes are lost.</div>';
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:center;margin-top:18px';
        const reload = document.createElement('button');
        reload.textContent = 'Reload';
        reload.style.cssText = 'padding:9px 20px;border-radius:999px;border:1px solid rgba(103,232,249,.6);background:#67e8f9;color:#04121a;font:700 13px ' + font + ';cursor:pointer';
        reload.onclick = function () { location.reload(); };
        const later = document.createElement('button');
        later.textContent = 'Later';
        later.style.cssText = 'padding:9px 20px;border-radius:999px;border:1px solid rgba(255,255,255,.18);background:transparent;color:#8b98ab;font:600 13px ' + font + ';cursor:pointer';
        const close = function () { back.remove(); document.removeEventListener('keydown', onKey); };
        const onKey = function (e) { if (e.key === 'Escape') close(); };
        later.onclick = close;
        back.onclick = function (e) { if (e.target === back) close(); };
        document.addEventListener('keydown', onKey);
        row.appendChild(reload); row.appendChild(later); card.appendChild(row); back.appendChild(card);
        document.body.appendChild(back);
        reload.focus();
    } catch { }
};
setTimeout(window.fiddleCheckVersion, 8000);
setInterval(window.fiddleCheckVersion, 10 * 60 * 1000);
// Generic queued intent (static pre-boot buttons -> Blazor): set by index.html, read once here.
window.fiddleTakeQueued = function (key) {
    try { const q = sessionStorage.getItem(key); if (q) sessionStorage.removeItem(key); return !!q; } catch { return false; }
};
// True once if the visitor clicked the static (pre-boot) Open editor button.
window.fiddleTakeQueuedEditor = function () {
    try { const q = sessionStorage.getItem('fx.openEditor'); if (q) sessionStorage.removeItem('fx.openEditor'); return !!q; } catch { return false; }
};

// Landing infinite scroll: call back into Blazor whenever the end-of-grid sentinel is near
// the viewport (600px ahead), so the next page + its thumbnails load just in time.
let fiddleEndObserver = null;
window.fiddleWatchEnd = function (el, dotnet) {
    window.fiddleUnwatchEnd();
    if (!el || !('IntersectionObserver' in window)) return;
    fiddleEndObserver = new IntersectionObserver(function (entries) {
        if (entries.some(function (e) { return e.isIntersecting; })) dotnet.invokeMethodAsync('OnEndVisible');
    }, { rootMargin: '600px 0px' });
    fiddleEndObserver.observe(el);
};
window.fiddleUnwatchEnd = function () {
    if (fiddleEndObserver) { fiddleEndObserver.disconnect(); fiddleEndObserver = null; }
};

// Copy text to clipboard; textarea fallback for non-secure contexts.
window.fiddleCopyText = function (text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { }
    document.body.removeChild(ta);
};

// Pin the console output panel to its latest line.
window.scrollFiddleConsole = function () {
    const el = document.getElementById('fiddle-console-body');
    if (el) el.scrollTop = el.scrollHeight;
};

window.setFiddleIntelliSense = function (on) {
    window.fiddleIntelliSense.enabled = !!on;
    if (!on) {
        // Clear squiggles immediately when turned off.
        const models = (typeof monaco !== 'undefined') ? monaco.editor.getModels() : [];
        models.forEach(function (m) { monaco.editor.setModelMarkers(m, 'fiddle', []); });
    } else {
        window.fiddleRunDiagnostics && window.fiddleRunDiagnostics();
    }
};

// Debounced diagnostics: on every edit, ask Roslyn for errors/warnings and paint
// them as Monaco markers (squiggles).
function wireFiddleDiagnostics() {
    const state = window.fiddleIntelliSense;
    const editor = (typeof monaco !== 'undefined') ? monaco.editor.getEditors()[0] : null;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    // Ctrl/Cmd+S recompiles (manual Run). Monaco captures the keybinding while the
    // editor is focused, so the browser's Save dialog is suppressed.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, function () {
        if (state.dotnet) {
            try { state.dotnet.invokeMethodAsync('RunFromShortcut'); } catch { }
        }
    });

    let timer;
    let inFlight = false;      // a pass is running
    let dirty = false;         // edits arrived while it was running
    const run = async function () {
        if (!state.enabled || !state.dotnet) {
            monaco.editor.setModelMarkers(model, 'fiddle', []);
            return;
        }
        // One pass at a time. Without this the debounce only delayed the START: on a big snippet
        // a pass outlives the 400 ms window, so passes pile up and queue on the single WASM
        // thread — which is what made typing inside a string compile on every character.
        if (inFlight) { dirty = true; return; }
        inFlight = true;
        let diags;
        try {
            diags = await state.dotnet.invokeMethodAsync('GetDiagnostics', model.getValue());
        } catch {
            // Swallowing this used to end HotReload for good if the user stopped typing right
            // then: no markers, no AutoCompile, and nothing left to re-trigger it.
            inFlight = false;
            window.fiddleRunDiagnostics();
            return;
        } finally {
            inFlight = false;
        }
        const sev = monaco.MarkerSeverity;
        const markers = (diags || []).map(function (d) {
            return {
                startLineNumber: d.startLine,
                startColumn: d.startColumn,
                endLineNumber: d.endLine,
                endColumn: d.endColumn,
                message: d.message,
                severity: d.severity === 'Error' ? sev.Error : sev.Warning,
            };
        });
        monaco.editor.setModelMarkers(model, 'fiddle', markers);

        // AutoCompile: run once the code is error-free. C# side skips if unchanged.
        const hasError = (diags || []).some(function (d) { return d.severity === 'Error'; });
        if (state.autoCompile && !hasError) {
            try { await state.dotnet.invokeMethodAsync('AutoCompile'); } catch { }
        }
        // Edits during the pass: one trailing run, so the last keystroke is never the lost one.
        if (dirty) { dirty = false; window.fiddleRunDiagnostics(); }
    };

    // Debounce grows with the file: a pass over 8 KB of C# costs well over 400 ms, and firing
    // that often just queues work the user never sees.
    window.fiddleRunDiagnostics = function () {
        const chars = model.getValueLength ? model.getValueLength() : model.getValue().length;
        const delay = Math.min(1200, 400 + Math.floor(chars / 2000) * 200);
        clearTimeout(timer);
        timer = setTimeout(run, delay);
    };
    model.onDidChangeContent(function () { window.fiddleRunDiagnostics(); });
    run(); // initial pass
}

// window.fiddle — automation API for AI agents and tests. Everything an agent
// needs to drive the fiddle without simulating Monaco keystrokes:
//   await fiddle.getState()        -> { ready, running, status, errors }
//   await fiddle.getCode()         -> current editor code
//   await fiddle.setCode(code)     -> replace editor code
//   await fiddle.run()             -> { success, errors, status } (compiles + renders)
//   await fiddle.getConsole()      -> Console.WriteLine lines from the snippet
//   await fiddle.listPresets()     -> [{ slug, name }]
//   await fiddle.loadPreset(slug)  -> true/false (loads + runs)
// Canvas pixels: use a compositor screenshot (e.g. Playwright element screenshot of
// '.fiddle-canvas canvas') — WebGL preserveDrawingBuffer:false makes toDataURL blank.
// Scroll to the current #hash target (docs anchors) once Blazor has rendered the page.
window.fiddleScrollHash = function () {
    const id = decodeURIComponent((location.hash || '').slice(1));
    const el = id && document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start' });
};

// Fiddle.Query / Fiddle.Emit / Fiddle.Open backend for the player (/p/{id}, #play=): params come from
// this page's URL; events go to the embedding page as postMessage({ fiddle, app, data }) and to a
// 'fiddle' DOM event; open = parent decides when embedded, else same-tab navigation.
window.fiddleSearch = function () { return location.search || ''; };
window.fiddleEmit = function (name, dataJson) {
    let data = null; try { data = JSON.parse(dataJson); } catch { }
    const app = (location.pathname.match(/\/p\/([A-Za-z0-9]+)/) || [])[1] || (location.hash.match(/play=([A-Za-z0-9]+)/) || [])[1] || null;
    const msg = { fiddle: name, app, data };
    if (window.parent !== window) window.parent.postMessage(msg, '*');
    window.dispatchEvent(new CustomEvent('fiddle', { detail: msg }));
    console.log('[fiddle]', name, data);
    // A toast is an authoring aid: it belongs in the editor, never on a published app where the
    // visitor is a customer, not the developer. `app` is set only in player mode (/p/{id}, #play=),
    // so the editor still shows it, and ?debug=1 brings it back for troubleshooting a live link.
    const debug = /[?&]debug=1/.test(location.search);
    if (!app || debug) window.fiddleToast('⚡ ' + name + ' ' + (dataJson || ''));
};
// Small transient toast (top-right) so an emitted event is visible without opening the console.
window.fiddleToast = function (text) {
    let host = document.getElementById('fx-toasts');
    if (!host) {
        host = document.createElement('div'); host.id = 'fx-toasts';
        host.style.cssText = 'position:fixed;top:14px;right:14px;z-index:10000;display:flex;flex-direction:column;gap:6px;pointer-events:none;font:13px/1.4 "Segoe UI",Roboto,Helvetica,Arial,sans-serif';
        document.body.appendChild(host);
    }
    const el = document.createElement('div');
    el.textContent = text.length > 160 ? text.slice(0, 160) + '…' : text;
    el.style.cssText = 'background:rgba(11,15,20,.92);color:#9ee8f5;border:1px solid rgba(103,232,249,.4);border-radius:10px;padding:8px 12px;max-width:360px;box-shadow:0 4px 18px rgba(0,0,0,.5);opacity:0;transition:opacity .2s';
    host.appendChild(el); requestAnimationFrame(() => el.style.opacity = '1');
    setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 250); }, 3200);
};
// Fiddle.Load in the browser: fetch text (JSON) — CORS applies, size capped like the server (256 KB).
window.fiddleFetch = async function (url) {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const t = await r.text();
    if (t.length > 256 * 1024) throw new Error('response too large (> 256 KB)');
    return t;
};
window.fiddleOpen = function (url) {
    if (window.parent !== window) window.parent.postMessage({ fiddle: 'open', url }, '*');
    else location.href = url;
};

// Small per-browser settings (e.g. the last MAUI project name). Private browsing throws, so
// both helpers stay silent and the caller falls back to its own default.
window.fiddleGetLocal = function (key) {
    try { return localStorage.getItem(key); } catch { return null; }
};
window.fiddleSetLocal = function (key, value) {
    try { localStorage.setItem(key, value); } catch { }
};

// Save bytes as a local file (Export -> Download frame). Base64 in, browser download out.
window.fiddleDownload = function (name, mime, b64) {
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
};

window.registerFiddleApi = function (dotnetRef) {
    window.fiddle = {
        getState: function () { return dotnetRef.invokeMethodAsync('ApiGetState'); },
        getCode: function () { return dotnetRef.invokeMethodAsync('ApiGetCode'); },
        setCode: function (code) { return dotnetRef.invokeMethodAsync('ApiSetCode', code); },
        run: function () { return dotnetRef.invokeMethodAsync('ApiRun'); },
        getConsole: function () { return dotnetRef.invokeMethodAsync('ApiGetConsole'); },
        listPresets: function () { return dotnetRef.invokeMethodAsync('ApiListPresets'); },
        loadPreset: function (slug) { return dotnetRef.invokeMethodAsync('ApiLoadPreset', slug); },
        // Load whatever the URL points at right now into this already-running editor. The
        // landing calls it after a pushState so opening another fiddle costs no runtime boot.
        openDeepLink: function () { return dotnetRef.invokeMethodAsync('ApiOpenDeepLink'); },
    };
};

window.registerFiddleCompletion = function (dotnetRef) {
    window.fiddleIntelliSense.dotnet = dotnetRef;

    if (window.fiddleIntelliSense.registered || typeof monaco === 'undefined')
        return;
    window.fiddleIntelliSense.registered = true;

    wireFiddleDiagnostics();

    monaco.languages.registerCompletionItemProvider('csharp', {
        triggerCharacters: ['.'],
        provideCompletionItems: async function (model, position) {
            const state = window.fiddleIntelliSense;
            if (!state.enabled || !state.dotnet)
                return { suggestions: [] };

            const code = model.getValue();
            const offset = model.getOffsetAt(position);

            let items;
            try {
                items = await state.dotnet.invokeMethodAsync('GetCompletions', code, offset);
            } catch {
                return { suggestions: [] };
            }
            if (!items || !items.length)
                return { suggestions: [] };

            const word = model.getWordUntilPosition(position);
            const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: word.startColumn,
                endColumn: word.endColumn,
            };

            const kinds = monaco.languages.CompletionItemKind;
            return {
                suggestions: items.map(function (i) {
                    return {
                        label: i.label,
                        insertText: i.insertText,
                        kind: kinds[i.kind] != null ? kinds[i.kind] : kinds.Property,
                        range: range,
                    };
                }),
            };
        },
    });
};
