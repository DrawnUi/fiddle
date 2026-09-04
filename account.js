// Account: session + the whole account panel, without .NET.
//
// Port of FiddleSession.cs + FiddleAccount.razor. Every call is plain REST against the fiddle
// worker, so none of it ever needed the runtime — it only lived in Blazor because the panel did.
// Owns the session for the page: landing.js reads the user from here and never touches the token.
//
// One thing genuinely cannot move: "Seed community from presets" compiles every built-in preset
// with Roslyn, so it needs the editor. The button asks window.fiddleRequestSeed (registered by the
// Blazor page when it is loaded) and otherwise says to open /app first — same wording as before.
window.FiddleAccount = (function () {
    'use strict';

    // Same rule as FiddleSession: local dev talks to `wrangler dev`, anything else to production.
    var API = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? 'http://localhost:8787'
        : 'https://fiddle.drawnui.net';
    var TOKEN_KEY = 'fiddle.session';

    var AOT_TIP = 'AOT build: the app, DrawnUI and SkiaSharp are compiled to native WebAssembly — faster for CPU-heavy C# (physics, particles, big loops). Costs a larger download (~15 MB vs ~9) and an ~8 min build. Plain builds are best for most UI apps.';
    var SERVER_TIP = 'Server app: rendered on our server and streamed to the viewer as video-like frames (live.fiddle.drawnui.net/x/…). Nothing to download — opens instantly on any device, taps work. Best for charts, dashboards, demos. Frame rate and session length are capped.';

    var S = {
        token: null, user: null, usage: null,
        open: false, tab: 'account', busy: false, error: null,
        email: '', code: '', codeSent: false, devCode: null, name: '', nameSeeded: false,
        items: [], apps: [], subs: [], reports: [], rows: [], backups: [],
        newEmail: '', newPlan: 'premium', importText: '', filter: 'all',
        backupStatus: null, noThumb: {}, poll: null,
        stats: {}, statsAt: null, top: [], statsBy: 'play', rollupStatus: null, statsBusy: false
    };

    var listeners = [];
    function changed() { listeners.forEach(function (f) { try { f(); } catch (e) { } }); }

    // ---------------------------------------------------------------- helpers

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function date(ms) { return ms ? new Date(ms).toISOString().slice(0, 10) : ''; }
    function size(b) {
        b = b || 0;
        return b >= 1048576 ? (b / 1048576).toFixed(1).replace(/\.0$/, '') + ' MB'
            : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
    }
    function pct(used, max) { return max > 0 ? Math.min(100, Math.floor(used * 100 / max)) : 0; }
    function isAdmin() { return !!(S.user && S.user.role === 'admin'); }
    function isPremium() { return !!(S.user && S.user.effectivePlan === 'premium'); }
    function thumbUrl(id, v) { return API + '/f/' + id + '/og.png' + (v ? '?v=' + v : ''); }
    // Apps open as the standalone player, fiddles in the editor.
    function publicUrl(it) { return 'https://fiddle.drawnui.net/' + (it.kind === 'app' ? 'p' : 'f') + '/' + it.id; }
    function editorUrl(it) { return location.origin + '/app#id=' + it.id; }
    function openUrl(it) { return it.kind === 'app' ? API + '/p/' + it.id : editorUrl(it); }
    // Accepts a bare id, /f/{id}, /p/{id}, /c/{id} or #id={id}.
    function extractId(s) {
        var m = String(s || '').trim().replace(/\/+$/, '').match(/([A-Za-z0-9]{6,16})$/);
        return m ? m[1] : null;
    }
    function copyText(text) {
        if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); } catch (e) { }
        document.body.removeChild(ta);
        return Promise.resolve();
    }
    function download(name, type, text) {
        var url = URL.createObjectURL(new Blob([text], { type: type }));
        var a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
    }

    // ---------------------------------------------------------------- api

    async function api(method, path, body, raw) {
        var init = { method: method, headers: {} };
        if (S.token) init.headers['Authorization'] = 'Bearer ' + S.token;
        if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(body); }
        try {
            var r = await fetch(API + path, init);
            var text = await r.text();
            if (raw) {
                if (r.ok) return { ok: true, status: r.status, value: text };
                var e = null;
                try { e = JSON.parse(text).error; } catch (x) { }
                return { ok: false, status: r.status, error: e || ('HTTP ' + r.status) };
            }
            var value = null;
            if (text) { try { value = JSON.parse(text); } catch (x) { } }
            if (!r.ok) return { ok: false, status: r.status, error: (value && (value.error || value.message)) || ('HTTP ' + r.status) };
            return { ok: true, status: r.status, value: value };
        } catch (ex) {
            return { ok: false, status: 0, error: (ex && ex.message) || 'network error' };
        }
    }

    // ---------------------------------------------------------------- session

    async function restore() {
        try { S.token = localStorage.getItem(TOKEN_KEY); } catch (e) { S.token = null; }
        if (!S.token) return;
        await refresh();
    }

    async function refresh() {
        if (!S.token) return;
        var r = await api('GET', '/api/me');
        if (r.ok) { S.user = r.value.user; S.usage = r.value.usage || null; seedName(); }
        else if (r.status === 401) { S.token = null; S.user = null; try { localStorage.removeItem(TOKEN_KEY); } catch (e) { } }
        changed();
    }

    function seedName() {
        if (S.user && !S.nameSeeded) { S.name = S.user.name || ''; S.nameSeeded = true; }
        if (!S.user) S.nameSeeded = false;
    }

    async function sendCode() {
        if (S.busy || !S.email.trim()) return;
        S.busy = true; S.error = null; S.devCode = null; render();
        var r = await api('POST', '/auth/start', { email: S.email.trim() });
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        S.codeSent = true; S.code = '';
        S.devCode = (r.value && r.value.code) || null;      // worker echoes it in local dev only
        render();
    }

    async function verify() {
        if (S.busy || S.code.length < 6) return;
        S.busy = true; S.error = null; render();
        var r = await api('POST', '/auth/verify', { email: S.email.trim(), code: S.code });
        S.busy = false;
        if (!r.ok) { S.error = r.error; S.code = ''; render(); return; }
        S.token = r.value.token; S.user = r.value.user;
        try { localStorage.setItem(TOKEN_KEY, S.token); } catch (e) { }
        S.codeSent = false; S.code = ''; S.tab = 'account'; seedName();
        S.open = false;                 // signed in: back to what the user was doing, no panel
        render(); changed();
    }

    async function signOut() {
        S.token = null; S.user = null; S.usage = null;
        try { localStorage.removeItem(TOKEN_KEY); } catch (e) { }
        S.tab = 'account'; S.rows = []; S.items = []; S.apps = [];
        S.codeSent = false; S.email = ''; S.code = ''; S.nameSeeded = false;
        S.open = false;                 // signed out: close, do not drop into the sign-in dialog
        render(); changed();
    }

    async function saveName() {
        S.busy = true; S.error = null; render();
        var r = await api('PUT', '/api/me', { name: S.name.trim() });
        S.busy = false;
        if (!r.ok) S.error = r.error; else { S.user = r.value.user; S.name = S.user.name || ''; changed(); }
        render();
    }

    async function deleteAccount() {
        if (!confirm('Delete your account? Your library, submissions, votes and published apps are removed. Shared links you created stay reachable until they expire (they hold no identity). This cannot be undone.')) return;
        S.busy = true; S.error = null; render();
        var r = await api('DELETE', '/api/me');
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        await signOut();
    }

    // ---------------------------------------------------------------- library + apps

    async function loadLibrary() {
        S.busy = true; S.error = null;
        var r = await api('GET', '/api/library');
        S.busy = false;
        if (r.ok) S.items = r.value.items || []; else S.error = r.error;
    }

    async function loadApps() {
        if (!isPremium() && !isAdmin()) return;
        var r = await api('GET', '/api/publish');
        if (!r.ok) return;
        var wasBuilding = S.apps.some(function (a) { return a.status === 'building'; });
        S.apps = r.value.apps || [];
        // A build just finished: refresh the session so Usage (bytes) reflects it.
        if (wasBuilding && !S.apps.some(function (a) { return a.status === 'building'; })) await refresh();
        // A build in flight: poll every 15 s until it settles.
        if (S.apps.some(function (a) { return a.status === 'building'; })) {
            if (!S.poll) S.poll = setInterval(function () { loadApps().then(render); }, 15000);
        } else if (S.poll) { clearInterval(S.poll); S.poll = null; }
    }

    // ---------------------------------------------------------------- stats
    //
    // Counts come from a nightly rollup of the click events into one KV map, so they are
    // lifetime totals as of `rolledUpTo` — never live. The age is shown wherever numbers are,
    // because a stalled rollup (an expired token did exactly that for five weeks) otherwise
    // looks like "nobody opened my fiddle".

    async function loadStats(ids) {
        if (!ids.length) return;
        var r = await api('GET', '/api/stats?ids=' + encodeURIComponent(ids.join(',')));
        if (!r.ok) return;
        S.statsAt = r.value.rolledUpTo || null;
        (r.value.top || []).forEach(function (e) { S.stats[e.id] = e; });
    }

    async function loadTop() {
        S.statsBusy = true;
        var r = await api('GET', '/api/stats?top=50&by=' + S.statsBy);
        S.statsBusy = false;
        if (!r.ok) { S.error = r.error; return; }
        S.statsAt = r.value.rolledUpTo || null;
        S.top = r.value.top || [];
    }

    async function runRollup() {
        S.statsBusy = true; S.rollupStatus = 'Running…'; render();
        var r = await api('POST', '/api/stats/rollup');
        S.statsBusy = false;
        var v = r.value || {};
        // Only v.ok === true is a real run: a shape without it means the request never reached
        // the rollup (that is exactly how the route being shadowed by /api/stats/{id} hid itself).
        S.rollupStatus = !r.ok ? '✗ ' + r.error
            : v.ok !== true ? '✗ ' + (v.error || 'the rollup did not run — unexpected response')
                : '✓ ' + v.points + ' events in ' + v.rows + ' rows (' + v.since + ' → ' + v.until + ')';
        if (r.ok && v.ok === true) await loadTop();
        render();
    }

    // Days since the rollup last ran; null when it has never run.
    function statsAgeDays() {
        return S.statsAt ? Math.floor((Date.now() - S.statsAt) / 86400000) : null;
    }
    function freshnessHtml() {
        var d = statsAgeDays();
        if (d === null) return '<span class="fa-hint" style="margin:0">No rollup has run yet.</span>';
        var txt = 'Counts as of ' + date(S.statsAt) + (d > 1 ? ' — ' + d + ' days ago' : ' (today)');
        return d > 2
            ? '<span class="fa-err" style="margin:0">' + esc(txt) + '. The nightly rollup is behind; clicks since then are recorded but not counted yet.</span>'
            : '<span class="fa-hint" style="margin:0">' + esc(txt) + '</span>';
    }
    function countsHtml(id) {
        var e = S.stats[id];
        if (!e) return '';
        var parts = [];
        if (e.play) parts.push('▶ ' + e.play + ' play' + (e.play > 1 ? 's' : ''));
        if (e.open) parts.push(e.open + ' opened in editor');
        if (e.code) parts.push(e.code + ' source view' + (e.code > 1 ? 's' : ''));
        if (e.view) parts.push(e.view + ' link view' + (e.view > 1 ? 's' : ''));
        if (e.share) parts.push(e.share + ' share' + (e.share > 1 ? 's' : ''));
        if (e.img) parts.push(e.img + ' preview hit' + (e.img > 1 ? 's' : ''));
        return parts.length ? '<div class="fa-item-meta">' + parts.join(' · ') + '</div>' : '';
    }

    async function openList(tab) {
        S.tab = tab; S.importText = ''; S.filter = 'all'; render();
        await loadLibrary(); await loadApps(); render();
        await loadStats(S.items.map(function (i) { return i.id; })); render();
    }

    function appOf(id) { return S.apps.filter(function (a) { return a.id === id; }); }

    // Library filters (client-side over the loaded rows). Premium-only facets appear only for premium.
    function filters() {
        var f = [['all', 'All'], ['community', 'Community'], ['review', 'In review']];
        if (isPremium()) f.push(['pinned', 'Pinned'], ['published', 'Published'], ['aot', 'AOT']);
        return f;
    }
    function matchesKey(it, key) {
        switch (key) {
            case 'community': return it.advertised === 1;
            case 'review': return it.advertised === 2;
            case 'pinned': return it.pinned === 1;
            case 'published': return appOf(it.id).some(function (a) { return a.status === 'ok' || a.server === 1; });
            case 'aot': return appOf(it.id).some(function (a) { return a.status === 'ok' && a.aot === 1; });
            default: return true;
        }
    }

    async function importItem() {
        var id = extractId(S.importText);
        if (!id) return;
        S.busy = true; S.error = null; render();
        var r = await api('POST', '/api/library/' + id + '?kind=' + (S.tab === 'apps' ? 'app' : 'fiddle'));
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        S.importText = '';
        await loadLibrary(); render();
    }

    async function saveTitle(it, title) {
        it.title = title;
        var r = await api('PUT', '/api/library/' + it.id + '?kind=' + it.kind, { title: title, pinned: null });
        if (!r.ok) { S.error = r.error; render(); }
    }

    async function togglePin(it) {
        var r = await api('PUT', '/api/library/' + it.id + '?kind=' + it.kind, { title: null, pinned: it.pinned === 0 });
        if (r.ok) it.pinned = it.pinned === 0 ? 1 : 0; else S.error = r.error;
        render();
    }

    async function submit(it) {
        S.busy = true; S.error = null; render();
        var r = await api('POST', '/api/community/' + it.id + '/submit?kind=' + it.kind);
        S.busy = false;
        if (r.ok) { it.advertised = r.value.status; it.reviewNote = ''; } else S.error = r.error;
        render();
    }

    async function withdraw(it) {
        S.busy = true; S.error = null; render();
        var r = await api('DELETE', '/api/community/' + it.id + '/submit?kind=' + it.kind);
        S.busy = false;
        if (r.ok) it.advertised = 0; else S.error = r.error;
        render();
    }

    async function removeItem(it) {
        var r = await api('DELETE', '/api/library/' + it.id + '?kind=' + it.kind);
        if (r.ok) S.items = S.items.filter(function (x) { return x !== it; }); else S.error = r.error;
        render();
    }

    async function publish(id, aot) {
        S.busy = true; S.error = null; render();
        var r = await api('POST', '/api/publish/' + id, { aot: !!aot });
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        await loadApps(); await refresh(); render();
    }

    async function publishServer(id) {
        S.busy = true; S.error = null; render();
        var r = await api('POST', '/api/publish/' + id, { server: true });
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        await loadApps(); await refresh(); render();
    }

    async function unpublish(pa) {
        S.busy = true; S.error = null; render();
        var r = await api('DELETE', '/api/publish/' + pa.id);
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        S.apps = S.apps.filter(function (a) { return a !== pa; });
        await refresh(); render();
    }

    // ---------------------------------------------------------------- admin

    async function openReview() {
        S.tab = 'review'; S.error = null; render();
        await loadSubmissions(); await loadReports(); render();
    }
    async function openAdmin() {
        S.tab = 'admin'; render();
        await loadUsers(); await loadBackups(); render();
    }
    async function loadSubmissions() {
        var r = await api('GET', '/api/community/submissions');
        if (r.ok) S.subs = r.value.submissions || [];
    }
    async function loadReports() {
        var r = await api('GET', '/api/community/reports');
        if (r.ok) S.reports = r.value.reports || [];
    }

    async function review(sb, approve) {
        var note = null;
        if (!approve) { note = prompt('Reason for the author (optional)', ''); if (note === null) return; }
        S.busy = true; S.error = null; render();
        var r = await api('PUT', '/api/community/' + sb.id + '/review?kind=' + sb.kind, { approve: approve, note: note });
        S.busy = false;
        if (r.ok) S.subs = S.subs.filter(function (x) { return x !== sb; }); else S.error = r.error;
        render();
    }

    async function removeReported(rp) {
        S.busy = true; var r = await api('DELETE', '/api/community/' + rp.id + '?kind=' + rp.kind); S.busy = false;
        if (r.ok) rp.live = 0; else S.error = r.error;
        render();
    }
    async function ignoreReported(rp) {
        S.busy = true; var r = await api('DELETE', '/api/community/' + rp.id + '/report?kind=' + rp.kind); S.busy = false;
        if (r.ok) S.reports = S.reports.filter(function (x) { return x !== rp; }); else S.error = r.error;
        render();
    }
    async function banReported(rp) {
        S.busy = true; var r = await api('PUT', '/api/community/' + rp.id + '/ban?kind=' + rp.kind); S.busy = false;
        if (r.ok) S.reports = S.reports.filter(function (x) { return x !== rp; }); else S.error = r.error;
        render();
    }

    async function loadUsers() {
        S.busy = true; S.error = null;
        var r = await api('GET', '/admin/users');
        S.busy = false;
        if (!r.ok) { S.error = r.error; return; }
        S.rows = (r.value.users || []).map(function (u) {
            var o = u.overrides || {};
            return {
                email: u.email, banned: u.banned === 1, bytes: u.bytes,
                edit: { role: u.role, plan: u.plan, expires: u.expires, maxApps: o.maxApps, maxBytes: o.maxBytes, maxPubMonth: o.maxPubMonth },
                // Bound as a date for <input type=date>; MB instead of raw bytes for humans.
                expiresDate: u.expires ? new Date(u.expires).toISOString().slice(0, 10) : '',
                maxMb: (o.maxBytes || o.maxBytes === 0) ? Math.round(o.maxBytes / 1048576) : ''
            };
        });
    }

    async function addUser() {
        S.busy = true; S.error = null; render();
        var r = await api('PUT', '/admin/users/' + encodeURIComponent(S.newEmail.trim()), { role: 'user', plan: S.newPlan });
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        S.newEmail = '';
        await loadUsers(); render();
    }

    async function saveUser(row) {
        row.edit.expires = row.expiresDate ? Date.parse(row.expiresDate + 'T00:00:00Z') : null;
        row.edit.maxBytes = row.maxMb === '' || row.maxMb === null ? null : Number(row.maxMb) * 1048576;
        S.busy = true; S.error = null; render();
        var r = await api('PUT', '/admin/users/' + encodeURIComponent(row.email), row.edit);
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        if (S.user && row.email === S.user.email) await refresh();
        await loadUsers(); render();
    }

    async function banUser(row) {
        if (!row.banned && !confirm('Suspend ' + row.email + '? Sign-in refused, all listings unlisted, display name cleared.')) return;
        S.busy = true; S.error = null; render();
        var r = await api('POST', '/admin/users/' + encodeURIComponent(row.email), { banned: !row.banned });
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        await loadUsers(); render();
    }

    async function deleteUser(row) {
        S.busy = true; S.error = null; render();
        var r = await api('DELETE', '/admin/users/' + encodeURIComponent(row.email));
        S.busy = false;
        if (!r.ok) { S.error = r.error; render(); return; }
        await loadUsers(); render();
    }

    async function loadBackups() {
        var r = await api('GET', '/admin/backups');
        if (r.ok) S.backups = r.value.backups || [];
    }

    async function exportBackup() {
        S.busy = true; S.backupStatus = 'Collecting…'; render();
        var r = await api('GET', '/admin/backup', undefined, true);
        S.busy = false;
        if (!r.ok) { S.backupStatus = '✗ ' + r.error; render(); return; }
        var name = 'fiddle-community-' + new Date().toISOString().slice(0, 10) + '.json';
        download(name, 'application/json', r.value);
        S.backupStatus = '✓ Saved ' + name + ' (' + Math.round(r.value.length / 1024) + ' KB)';
        render();
    }

    async function importBackup(file) {
        S.busy = true; S.backupStatus = 'Importing…'; render();
        try {
            var text = await file.text();
            var r = await api('POST', '/admin/backup', JSON.parse(text));
            S.backupStatus = !r.ok ? '✗ ' + r.error
                : r.value.error ? '✗ ' + r.value.error
                    : '✓ Imported ' + r.value.imported + ', skipped ' + r.value.skipped +
                      ((r.value.errors && r.value.errors.length) ? ' — ' + r.value.errors.slice(0, 3).join('; ') : '');
        } catch (ex) { S.backupStatus = '✗ ' + ((ex && ex.message) || 'import failed'); }
        S.busy = false; render();
    }

    // Seeding compiles every preset with Roslyn, so only the editor page can do it. The Blazor page
    // registers window.fiddleRequestSeed; anywhere else this says where to go, exactly as before.
    function requestSeed() {
        if (typeof window.fiddleRequestSeed === 'function') { window.fiddleRequestSeed(); return; }
        S.backupStatus = null;
        S.seedStatus = 'Open the editor (/app) first, then seed from there.';
        render();
    }

    // ---------------------------------------------------------------- render

    function tabsHtml() {
        var t = function (id, label, testid) {
            return '<button class="fa-tab' + (S.tab === id ? ' on' : '') + '" data-act="tab" data-tab="' + id + '"' +
                (testid ? ' data-testid="' + testid + '"' : '') + '>' + label + '</button>';
        };
        var pending = S.subs.length + S.reports.length;
        return '<div class="fa-tabs">' +
            t('account', 'Account') +
            t('fiddles', 'My fiddles', 'fiddle-account-fiddles-tab') +
            t('apps', 'My apps', 'fiddle-account-apps-tab') +
            (isPremium() ? t('usage', 'Usage') : '') +
            (isAdmin() ? t('stats', 'Stats', 'fiddle-account-stats-tab') : '') +
            (isAdmin() ? t('review', 'Review' + (pending > 0 ? ' (' + pending + ')' : ''), 'fiddle-account-review-tab') : '') +
            (isAdmin() ? t('admin', 'Admin', 'fiddle-account-admin-tab') : '') +
            '</div>';
    }

    function accountTabHtml() {
        var u = S.user;
        return '<dl class="fa-kv">' +
            '<dt>Email</dt><dd data-testid="fiddle-account-email-value">' + esc(u.email) + '</dd>' +
            '<dt>Display name</dt><dd><div class="fa-row" style="margin:0">' +
            '<input class="fa-input" id="fa-name" style="max-width:220px" maxlength="24" placeholder="shown on Community cards" value="' + esc(S.name) + '" data-testid="fiddle-account-name">' +
            '<button class="fa-primary fa-sm" data-act="save-name"' + (S.busy || S.name.trim() === (u.name || '') ? ' disabled' : '') + '>Save</button>' +
            '</div><span class="fa-hint" style="margin:4px 0 0">Your email is never shown. Leave empty to stay anonymous.</span></dd>' +
            '<dt>Plan</dt><dd>' + esc(u.effectivePlan) + '</dd>' +
            '<dt>Expires</dt><dd>' + (u.expires ? date(u.expires) : 'never') + '</dd>' +
            '<dt>Member since</dt><dd>' + date(u.created) + '</dd>' +
            '</dl>' +
            '<div class="fa-row">' +
            '<button class="fa-ghost" data-act="refresh">Refresh</button>' +
            '<button class="fa-primary fa-red" data-act="signout" data-testid="fiddle-account-signout">Sign out</button>' +
            (!isAdmin()
                ? '<button class="fa-ghost fa-danger" style="margin-left:auto" title="Removes your account and everything tied to it" data-act="delete-account"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-account-delete">Delete account</button>'
                : '') +
            '</div>';
    }

    function publishedAppsHtml() {
        if (!S.apps.length) return '<p class="fa-hint">None yet.</p>';
        return '<div class="fa-list" style="max-height:30vh;margin-bottom:14px" data-testid="fiddle-published-apps">' +
            S.apps.map(function (pa) {
                var head = pa.status === 'ok'
                    ? '<a class="fa-check on" style="padding:0" href="' + esc(pa.url) + '" target="_blank" rel="noopener">' + esc(String(pa.url).replace('https://', '')) + '</a>'
                    : (pa.server === 1 && pa.live)
                        ? '<a class="fa-check on" style="padding:0" href="' + esc(pa.live) + '" target="_blank" rel="noopener">' + esc(String(pa.live).replace('https://', '')) + '</a>'
                        : '<span>' + esc(pa.id) + '</span>';
                var meta = pa.status === 'ok' ? size(pa.bytes) + ' · DrawnUI ' + esc(pa.lib || '') + ' · ' + date(pa.updated)
                    : pa.status === 'failed' ? esc(pa.error || 'build failed')
                        : pa.status === 'building' ? 'usually 3–5 minutes'
                            : 'server app · ' + date(pa.updated);
                return '<div class="fa-item" data-app="' + esc(pa.id) + '">' +
                    '<img class="fa-thumb" src="' + esc(thumbUrl(pa.id)) + '" alt="" loading="lazy">' +
                    '<div class="fa-item-main"><div>' + head +
                    (pa.server === 1 ? '<span class="fa-badge" style="margin-left:8px;color:#86efac;border-color:rgba(74,222,128,.5)" title="' + esc(SERVER_TIP) + '">server</span>' : '') +
                    (pa.status !== 'none' ? '<span class="fa-badge' + (pa.status === 'ok' ? ' premium' : '') + '" style="margin-left:8px">' + (pa.status === 'building' ? 'building…' : pa.status === 'ok' ? 'published' : 'failed') + '</span>' : '') +
                    (pa.aot === 1 ? '<span class="fa-badge admin" style="margin-left:6px" title="' + esc(AOT_TIP) + '">AOT</span>' : '') +
                    '</div><div class="fa-item-meta">' + meta + '</div></div>' +
                    '<div class="fa-item-actions">' +
                    (pa.status === 'ok'
                        ? '<a class="fa-primary fa-sm" href="' + esc(pa.url) + '" target="_blank" rel="noopener">Open</a>' +
                          '<a class="fa-violet" href="' + esc(pa.zip) + '">Download zip</a>' : '') +
                    '<a class="fa-ghost fa-sm" href="' + esc(location.origin + '/app#id=' + pa.id) + '" target="_blank" title="Open the C# this app was built from">Open code</a>' +
                    ((pa.server === 1 && pa.live)
                        ? '<a class="fa-primary fa-sm" style="border-color:rgba(74,222,128,.5);background:rgba(34,197,94,.14);color:#86efac" href="' + esc(pa.live) + '" target="_blank" rel="noopener" title="' + esc(SERVER_TIP) + '">Open live</a>' +
                          '<a class="fa-ghost" href="' + esc(API + '/test/x/' + pa.id) + '" target="_blank" rel="noopener" title="Preview the server app inside an iframe and copy the HTML to paste into your page">Embed</a>' : '') +
                    (pa.status !== 'building'
                        ? '<button class="fa-ghost" data-act="republish" data-id="' + esc(pa.id) + '"' + (S.busy ? ' disabled' : '') + ' title="Rebuild with the current fiddle code and DrawnUI version">Rebuild</button>' +
                          '<button class="fa-ghost" data-act="republish-aot" data-id="' + esc(pa.id) + '"' + (S.busy ? ' disabled' : '') + ' title="' + esc(AOT_TIP) + '">Rebuild (AOT)</button>' +
                          '<button class="fa-ghost fa-danger" data-act="unpublish" data-id="' + esc(pa.id) + '"' + (S.busy ? ' disabled' : '') + '>Unpublish</button>' : '') +
                    '</div></div>';
            }).join('') + '</div>';
    }

    function libraryTabHtml() {
        var app = S.tab === 'apps';
        var kind = app ? 'app' : 'fiddle';
        var mine = S.items.filter(function (i) { return i.kind === kind; });
        var list = mine.filter(function (i) { return matchesKey(i, S.filter); });
        var premium = isPremium();

        var html = (S.error ? '<p class="fa-err" data-testid="fiddle-account-error">' + esc(S.error) + '</p>' : '') +
            '<div class="fa-row">' +
            '<input class="fa-input" id="fa-import" placeholder="' + (app ? 'got a web app link from someone? paste it here to add it' : 'got a fiddle link from someone? paste it here to add it') + '" value="' + esc(S.importText) + '" data-testid="fiddle-library-import">' +
            '<button class="fa-primary" data-act="import"' + (S.busy || !extractId(S.importText) ? ' disabled' : '') + '>Add</button>' +
            '</div>' +
            '<div class="fa-filters" data-testid="fiddle-library-filters">' +
            filters().map(function (f) {
                var n = mine.filter(function (i) { return matchesKey(i, f[0]); }).length;
                return '<button class="' + (S.filter === f[0] ? 'on' : '') + '" data-act="filter" data-filter="' + f[0] + '"' +
                    (n === 0 && f[0] !== 'all' ? ' disabled' : '') + '>' + f[1] + (n > 0 ? ' ' + n : '') + '</button>';
            }).join('') + '</div>';

        if (app && premium) {
            html += '<p class="fa-hint" style="margin:6px 0"><b>Published standalone apps</b> — trimmed builds on their own URL, no editor, no badge. <span style="opacity:.7">Publish any fiddle or app from its row below.</span></p>' +
                publishedAppsHtml();
        }

        if (!list.length) {
            html += '<p class="fa-hint">' + (S.filter !== 'all' ? 'Nothing matches this filter.'
                : app ? 'Nothing here yet. Every web app you export while signed in is saved here.'
                    : 'Nothing here yet. Every fiddle you share while signed in is saved here.') + '</p>';
            return html;
        }

        html += '<p style="margin:6px 0">' + freshnessHtml() + '</p>';
        html += '<p class="fa-hint"><b>Submit to Community</b> puts one up for review; once a moderator approves it, it appears on the <a href="/community" target="_blank" rel="noopener" style="color:#d8b4fe">Community</a> page where people can rate it.</p>' +
            '<div class="fa-list" data-testid="' + (app ? 'fiddle-apps' : 'fiddle-library') + '">' +
            list.map(function (it) {
                var building = appOf(it.id).some(function (a) { return a.status === 'building'; });
                var published = appOf(it.id).some(function (a) { return a.status === 'ok'; });
                var live = appOf(it.id).some(function (a) { return a.server === 1; });
                var status;
                switch (it.advertised) {
                    case 1: status = '<span class="fa-badge premium" title="Listed on the Community page">Community</span> <button class="fa-ghost" title="Take it off the Community page" data-act="withdraw" data-id="' + esc(it.id) + '"' + (S.busy ? ' disabled' : '') + '>Unlist</button>'; break;
                    case 2: status = '<span class="fa-badge" title="We review submissions before they go live">In review</span> <button class="fa-ghost" data-act="withdraw" data-id="' + esc(it.id) + '"' + (S.busy ? ' disabled' : '') + '>Withdraw</button>'; break;
                    case 3: status = '<span class="fa-badge" style="color:#fca5a5;border-color:rgba(248,113,113,.5)" title="' + esc(it.reviewNote ? 'Not accepted: ' + it.reviewNote : 'Not accepted for the Community page') + '">Not accepted</span> <button class="fa-ghost" title="Submit again after changing it" data-act="submit" data-id="' + esc(it.id) + '"' + (S.busy ? ' disabled' : '') + '>Resubmit</button>'; break;
                    default: status = '<button class="fa-violet" title="Submit to the Community page. A moderator reviews it first; you can withdraw any time." data-act="submit" data-id="' + esc(it.id) + '"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-submit">Submit to Community</button>';
                }
                return '<div class="fa-item" data-id="' + esc(it.id) + '">' +
                    (S.noThumb[it.id] ? '<div class="fa-thumb"></div>'
                        : '<img class="fa-thumb" src="' + esc(thumbUrl(it.id, it.thumb)) + '" alt="" loading="lazy" data-fa-thumb="' + esc(it.id) + '">') +
                    '<div class="fa-item-main">' +
                    '<input class="fa-input fa-item-title" placeholder="' + esc(it.id) + '" value="' + esc(it.title) + '" data-title-for="' + esc(it.id) + '">' +
                    '<div class="fa-item-meta">' + (!it.description || it.description === it.title ? '' : esc(it.description) + ' · ') + date(it.created) + ' · ' + size(it.bytes) + ' · ' + esc(it.id) + '</div>' +
                    countsHtml(it.id) +
                    '</div><div class="fa-item-actions">' +
                    '<a class="fa-primary fa-sm" href="' + esc(openUrl(it)) + '" target="_blank">' + (it.kind === 'app' ? 'Run' : 'Open') + '</a>' +
                    (it.kind === 'app' ? '<a class="fa-ghost fa-sm" href="' + esc(editorUrl(it)) + '" target="_blank" title="Open the C# of this app in the editor">Open code</a>' : '') +
                    '<button class="fa-violet" data-act="copy-link" data-id="' + esc(it.id) + '">Copy link</button>' +
                    (premium
                        ? '<button class="fa-primary fa-sm" style="border-color:rgba(168,85,247,.5);background:rgba(168,85,247,.12);color:#d8b4fe" title="Build this as a standalone app (trimmed, no editor, no badge) at fiddle.drawnui.net/a/… — takes a few minutes" data-act="publish" data-id="' + esc(it.id) + '"' + (S.busy || building ? ' disabled' : '') + ' data-testid="fiddle-publish">' + (published ? 'Republish' : building ? 'Building…' : 'Publish app') + '</button>' +
                          '<button class="fa-ghost" title="' + esc(AOT_TIP) + '" data-act="publish-aot" data-id="' + esc(it.id) + '"' + (S.busy || building ? ' disabled' : '') + ' data-testid="fiddle-publish-aot">(AOT)</button>' +
                          '<button class="fa-ghost" style="color:#86efac;border-color:rgba(74,222,128,.5)" title="' + esc(SERVER_TIP) + '" data-act="publish-server" data-id="' + esc(it.id) + '"' + (S.busy || live ? ' disabled' : '') + ' data-testid="fiddle-publish-server">' + (live ? 'Live ✓' : 'Publish server') + '</button>' +
                          '<button class="fa-ghost fa-pin' + (it.pinned === 1 ? ' on' : '') + '" title="Shares are deleted after 60 days without a single visit. Pinned ones are kept alive forever, even with zero visitors — your old embeds and links never break." data-act="pin" data-id="' + esc(it.id) + '">' + (it.pinned === 1 ? '★ Pinned' : '☆ Pin') + '</button>'
                        : '') +
                    status +
                    '<button class="fa-ghost fa-danger" data-act="remove-item" data-id="' + esc(it.id) + '">Remove</button>' +
                    '</div></div>';
            }).join('') + '</div>';
        return html;
    }

    function usageTabHtml() {
        var u = S.user, us = S.usage || {};
        return '<dl class="fa-kv">' +
            '<dt>Storage</dt><dd>' + size(u.bytes) + ' / ' + size(u.maxBytes) +
            '<div class="fa-bar"><i style="width:' + pct(u.bytes, u.maxBytes) + '%"></i></div></dd>' +
            '<dt>Published apps</dt><dd>' + (us.apps || 0) + ' / ' + u.maxApps + '</dd>' +
            '<dt>Publishes / month</dt><dd>' + (us.pubMonth || 0) + ' / ' + u.maxPubMonth + '</dd>' +
            '</dl>';
    }

    function reviewTabHtml() {
        var html = S.error ? '<p class="fa-err" data-testid="fiddle-account-error">' + esc(S.error) + '</p>' : '';
        if (S.subs.length) {
            html += '<p class="fa-hint" style="margin:6px 0"><b>Submissions</b> — waiting for review, oldest first</p>' +
                '<div class="fa-list" style="max-height:34vh;margin-bottom:14px" data-testid="fiddle-admin-submissions">' +
                S.subs.map(function (sb, i) {
                    var href = sb.kind === 'app' ? API + '/p/' + sb.id : location.origin + '/app#id=' + sb.id;
                    return '<div class="fa-item">' +
                        '<a href="' + esc(href) + '" target="_blank" title="Open"><img class="fa-thumb" style="width:128px;height:67px" src="' + esc(thumbUrl(sb.id)) + '" alt="" loading="lazy"></a>' +
                        '<div class="fa-item-main">' +
                        '<div><b>' + esc(sb.title || sb.id) + '</b> · ' + esc(sb.kind) + ' · ' + esc(sb.email) + (sb.name ? ' (“' + esc(sb.name) + '”)' : '') + ' · ' + (sb.submitted ? date(sb.submitted) : '') + '</div>' +
                        '<div class="fa-item-meta">' + esc(!sb.description || sb.description === sb.title ? sb.id : sb.description) + '</div>' +
                        '</div><div class="fa-item-actions">' +
                        '<button class="fa-primary fa-sm" data-act="approve" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-admin-approve">Approve</button>' +
                        '<button class="fa-ghost fa-danger" data-act="reject" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '>Reject</button>' +
                        '</div></div>';
                }).join('') + '</div>';
        }
        if (S.reports.length) {
            html += '<p class="fa-hint" style="margin:6px 0"><b>Reports</b> — newest first</p>' +
                '<div class="fa-list" style="max-height:30vh;margin-bottom:14px" data-testid="fiddle-admin-reports">' +
                S.reports.map(function (rp, i) {
                    var href = rp.kind === 'app' ? API + '/p/' + rp.id : location.origin + '/app#id=' + rp.id;
                    return '<div class="fa-item">' +
                        '<a href="' + esc(href) + '" target="_blank" title="Open"><img class="fa-thumb" style="width:128px;height:67px" src="' + esc(thumbUrl(rp.id)) + '" alt="" loading="lazy"></a>' +
                        '<div class="fa-item-main">' +
                        '<div><a class="fa-check on" style="padding:0" href="' + esc(href) + '" target="_blank">' + esc(rp.id) + '</a> · ' + esc(rp.kind) + ' · ' + rp.count + ' report' + (rp.count > 1 ? 's' : '') + ' · ' + date(rp.last) +
                        (rp.banned === 1 ? ' · banned' : rp.live === 0 ? ' · not listed' : '') + '</div>' +
                        '<div class="fa-item-meta">' + esc(rp.reason || 'no reason given') + '</div>' +
                        '</div><div class="fa-item-actions">' +
                        '<button class="fa-ghost" title="Drop the report, keep the item listed" data-act="ignore-report" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '>Ignore</button>' +
                        (rp.live === 1 ? '<button class="fa-ghost fa-danger" title="Take the item off the Community page" data-act="remove-report" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '>Remove</button>' : '') +
                        (rp.banned === 0 ? '<button class="fa-ghost fa-danger" data-act="ban-report" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '>Ban</button>' : '') +
                        '</div></div>';
                }).join('') + '</div>';
        }
        if (!S.subs.length && !S.reports.length) html += '<p class="fa-hint">Nothing to review — no pending submissions, no open reports.</p>';
        return html;
    }

    function statsTabHtml() {
        var rows = S.top;
        return '<div class="fa-row">' + freshnessHtml() + '</div>' +
            '<div class="fa-row">' +
            '<button class="fa-primary" title="Fold every click since the last run into the lifetime counts. The cron does this nightly; run it here to catch up or to check it still works." data-act="run-rollup"' + (S.statsBusy ? ' disabled' : '') + ' data-testid="fiddle-stats-rollup">Run rollup now</button>' +
            '<button class="fa-ghost" data-act="reload-stats"' + (S.statsBusy ? ' disabled' : '') + '>Reload</button>' +
            (S.rollupStatus ? '<span class="fa-hint" style="margin:0">' + esc(S.rollupStatus) + '</span>' : '') +
            '</div>' +
            (!rows.length
                ? '<p class="fa-hint">Nothing counted yet.</p>'
                : '<div class="fa-scroll"><table class="fa-table" data-testid="fiddle-stats-table">' +
                  '<thead><tr><th></th><th>Fiddle</th>' +
                  [['play', 'Plays'], ['open', 'Editor'], ['code', 'Source'], ['view', 'Link'], ['share', 'Shares'], ['img', 'Preview']]
                      .map(function (c) {
                          return '<th><button class="fa-sort' + (S.statsBy === c[0] ? ' on' : '') + '" data-act="stats-by" data-by="' + c[0] + '"' +
                              ' title="Order by ' + c[1] + '">' + c[1] + (S.statsBy === c[0] ? ' ▾' : '') + '</button></th>';
                      }).join('') +
                  '</tr></thead><tbody>' +
                  rows.map(function (e) {
                      var href = location.origin + '/app#id=' + e.id;
                      return '<tr data-id="' + esc(e.id) + '">' +
                          '<td><a href="' + esc(href) + '" target="_blank" title="Open in the editor">' +
                          (S.noThumb[e.id] ? '<div class="fa-thumb" style="width:64px;height:34px"></div>'
                              : '<img class="fa-thumb" style="width:64px;height:34px" src="' + esc(thumbUrl(e.id)) + '" alt="" loading="lazy" data-fa-thumb="' + esc(e.id) + '">') +
                          '</a></td>' +
                          '<td><div class="fa-stats-name">' +
                          '<a class="fa-check on" style="padding:0" href="' + esc(href) + '" target="_blank" title="' + esc(e.title || e.id) + '">' +
                          esc(e.title || e.id) + '</a>' +
                          (e.title ? '<div class="fa-item-meta">' + esc(e.id) + '</div>' : '') + '</div></td>' +
                          '<td class="fa-num">' + e.play + '</td><td class="fa-num">' + e.open + '</td>' +
                          '<td class="fa-num">' + e.code + '</td><td class="fa-num">' + e.view + '</td>' +
                          '<td class="fa-num">' + e.share + '</td><td class="fa-num">' + e.img + '</td>' +
                          '</tr>';
                  }).join('') + '</tbody></table></div>') +
            '<p class="fa-hint">Plays = the standalone app or player was opened · Editor = opened in the editor · ' +
            'Source = the source-embed iframe was loaded · Link = the /f/ share page was visited · Preview = the og.png was fetched (social cards, hotlinks).</p>';
    }

    function adminTabHtml() {
        var seedHint = S.seedStatus || 'Shares every built-in preset with a thumbnail and advertises them (owner presets@drawnui.net). Run from the editor page after a lib update.';
        var backupHint = S.backupStatus || (S.backups.length === 0
            ? 'Nightly copies land in R2 (backups/…), 30 kept.'
            : 'Nightly R2 copies: ' + S.backups.length + ' · latest ' + String(S.backups[0].key).replace('backups/', '') + ' (' + size(S.backups[0].size) + ')');
        return (S.error ? '<p class="fa-err" data-testid="fiddle-account-error">' + esc(S.error) + '</p>' : '') +
            '<div class="fa-row">' +
            '<input class="fa-input" id="fa-new-email" type="email" placeholder="add user by email" value="' + esc(S.newEmail) + '" data-testid="fiddle-admin-new-email">' +
            '<select class="fa-select" id="fa-new-plan" style="flex:0 0 120px">' +
            '<option value="free"' + (S.newPlan === 'free' ? ' selected' : '') + '>free</option>' +
            '<option value="premium"' + (S.newPlan === 'premium' ? ' selected' : '') + '>premium</option></select>' +
            '<button class="fa-primary" data-act="add-user"' + (S.busy || !S.newEmail.trim() ? ' disabled' : '') + ' data-testid="fiddle-admin-add">Add</button>' +
            '<button class="fa-ghost" data-act="reload-users"' + (S.busy ? ' disabled' : '') + '>Reload</button>' +
            '</div>' +
            '<div class="fa-scroll">' +
            '<div class="fa-row">' +
            '<button class="fa-violet" data-act="seed" data-testid="fiddle-admin-seed">Seed community from presets</button>' +
            '<span class="fa-hint" style="margin:0">' + esc(seedHint) + '</span>' +
            '</div>' +
            '<div class="fa-row" data-testid="fiddle-admin-backup">' +
            '<button class="fa-primary" title="Download a JSON snapshot of every Community / pending / pinned / premium / admin fiddle: code, description, canvas background, thumbnail, ratings, weights." data-act="export-backup"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-admin-export">Export community</button>' +
            '<label class="fa-ghost" style="cursor:pointer" title="Restore a snapshot (upsert: nothing is deleted, live items stay live)">Import…<input type="file" id="fa-import-backup" accept=".json,application/json" style="display:none"></label>' +
            '<span class="fa-hint" style="margin:0">' + esc(backupHint) + '</span>' +
            '</div>' +
            '<table class="fa-table" data-testid="fiddle-admin-users">' +
            '<thead><tr><th>Email</th><th>Role</th><th>Plan</th><th>Expires</th><th>Apps</th><th>MB</th><th>Pub/mo</th><th>Used</th><th></th></tr></thead><tbody>' +
            S.rows.map(function (row, i) {
                var sel = function (field, opts) {
                    return '<select class="fa-select" data-row="' + i + '" data-field="' + field + '">' +
                        opts.map(function (o) { return '<option value="' + o + '"' + (row.edit[field] === o ? ' selected' : '') + '>' + o + '</option>'; }).join('') + '</select>';
                };
                var num = function (field, val) {
                    return '<input class="fa-input" type="number" min="0" placeholder="dflt" value="' + (val === null || val === undefined ? '' : val) + '" data-row="' + i + '" data-field="' + field + '">';
                };
                return '<tr data-email="' + esc(row.email) + '">' +
                    '<td>' + esc(row.email) + (row.banned ? ' <span class="fa-badge" style="color:#fca5a5;border-color:rgba(248,113,113,.5)">banned</span>' : '') + '</td>' +
                    '<td>' + sel('role', ['user', 'admin']) + '</td>' +
                    '<td>' + sel('plan', ['free', 'premium']) + '</td>' +
                    '<td><input class="fa-input" type="date" value="' + esc(row.expiresDate) + '" data-row="' + i + '" data-field="expiresDate"></td>' +
                    '<td class="fa-num">' + num('maxApps', row.edit.maxApps) + '</td>' +
                    '<td class="fa-num">' + num('maxMb', row.maxMb) + '</td>' +
                    '<td class="fa-num">' + num('maxPubMonth', row.edit.maxPubMonth) + '</td>' +
                    '<td>' + size(row.bytes) + '</td>' +
                    '<td class="fa-actions">' +
                    '<button class="fa-primary fa-sm" data-act="save-user" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '>Save</button>' +
                    (S.user && row.email !== S.user.email
                        ? '<button class="fa-ghost' + (row.banned ? '' : ' fa-danger') + '" title="' + (row.banned ? 'Restore sign-in' : 'Suspend: sign-in refused, listings unlisted, name cleared') + '" data-act="ban-user" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '>' + (row.banned ? 'Unban' : 'Ban') + '</button>' +
                          '<button class="fa-ghost fa-danger" data-act="delete-user" data-i="' + i + '"' + (S.busy ? ' disabled' : '') + '>Delete</button>'
                        : '') +
                    '</td></tr>';
            }).join('') + '</tbody></table></div>';
    }

    function signInHtml() {
        var body;
        if (!S.codeSent) {
            body = '<div class="fa-row">' +
                '<input class="fa-input" id="fa-email" type="email" placeholder="you@example.com" value="' + esc(S.email) + '" data-testid="fiddle-account-email">' +
                '<button class="fa-primary" data-act="send-code"' + (S.busy || !S.email.trim() ? ' disabled' : '') + ' data-testid="fiddle-account-send">Send code</button>' +
                '</div>' +
                '<div class="fa-why" data-testid="fiddle-account-why">' +
                '<div class="fa-why-title">Why sign in? It&#39;s free.</div><ul class="fa-why-list">' +
                '<li><b>Never lose a fiddle.</b> Everything you share lands in your library — with thumbnails and titles you choose.</li>' +
                '<li><b>Pick up anywhere.</b> Your library and settings follow you across browsers and devices.</li>' +
                '<li><b>One click to publish.</b> Your library is where fiddles become shareable apps.</li>' +
                '<li><b>Vote on community snippets.</b> Votes decide what the feed shows first, and they are how authors hear that their work landed.</li>' +
                '</ul></div>' +
                '<p class="fa-hint" style="margin-top:10px">By signing in you agree to the <a href="/terms/" target="_blank" style="color:#8fd0ff">Terms of Service</a> and <a href="/privacy/" target="_blank" style="color:#8fd0ff">Privacy</a> notes.</p>';
        } else {
            body = '<p class="fa-hint">Code sent to <b>' + esc(S.email) + '</b>. Valid 10 minutes, single use.' +
                (S.devCode ? '<span class="fa-dev"> dev code: ' + esc(S.devCode) + '</span>' : '') + '</p>' +
                '<div class="fa-row">' +
                '<input class="fa-input fa-code" id="fa-code" inputmode="numeric" autocomplete="one-time-code" placeholder="······" value="' + esc(S.code) + '"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-account-code">' +
                (S.busy ? '<span class="fa-hint" style="margin:0">Verifying…</span>' : '') +
                '<button class="fa-ghost" data-act="change-email">Change email</button>' +
                '</div>';
        }
        return '<h3 class="fa-title">Sign in</h3>' +
            '<p class="fa-lead">No password. We email you a one-time code.</p>' +
            (S.error ? '<p class="fa-err" data-testid="fiddle-account-error">' + esc(S.error) + '</p>' : '') +
            body;
    }

    function host() {
        var h = document.getElementById('fa-host');
        if (!h) { h = document.createElement('div'); h.id = 'fa-host'; document.body.appendChild(h); }
        return h;
    }

    function render() {
        var h = host();
        if (!S.open) { h.innerHTML = ''; return; }
        var body;
        if (!S.user) body = signInHtml();
        else {
            body = '<h3 class="fa-title">Account <span class="fa-badge ' + esc(S.user.effectivePlan) + '" data-testid="fiddle-account-plan">' + esc(S.user.effectivePlan) + '</span>' +
                (isAdmin() ? '<span class="fa-badge admin">admin</span>' : '') + '</h3>' + tabsHtml() +
                (S.tab === 'account' ? accountTabHtml()
                    : (S.tab === 'fiddles' || S.tab === 'apps') ? libraryTabHtml()
                        : S.tab === 'usage' ? usageTabHtml()
                            : (S.tab === 'stats' && isAdmin()) ? statsTabHtml()
                                : (S.tab === 'review' && isAdmin()) ? reviewTabHtml()
                                : (S.tab === 'admin' && isAdmin()) ? adminTabHtml() : '');
        }
        h.innerHTML = '<div class="fa-overlay" data-act="close-account">' +
            '<div class="fa-card' + (S.user ? ' fa-wide' : '') + '" data-testid="fiddle-account-panel" data-stop="1">' +
            '<button class="fa-close" data-act="close-account" aria-label="Close">✕</button>' +
            body + '</div></div>';
        var f = document.getElementById(S.user ? 'fa-name' : (S.codeSent ? 'fa-code' : 'fa-email'));
        if (f && !S.user) f.focus();
    }

    // ---------------------------------------------------------------- events

    document.addEventListener('click', function (e) {
        var node = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!node) return;
        var act = node.getAttribute('data-act');
        if (act === 'close-account') {
            var stop = e.target.closest('[data-stop]');
            if (stop && node.contains(stop)) return;   // click inside the card bubbled to the backdrop
            S.open = false; S.error = null; render(); changed(); leaveLogin();
            return;
        }
        // The header's Account control is an <a href="/login"> — a real page for crawlers and for
        // "open in new tab". A plain click is caught by landing.js and turned into an in-document
        // move to /login; syncPanelToPath() below opens the panel from the URL, so there is nothing
        // to do here. (Without landing.js — the player — the link just navigates.)
        if (act === 'account') return;
        var h = document.getElementById('fa-host');
        if (!h || !h.contains(node)) return;

        var byId = function () { return S.items.filter(function (x) { return x.id === node.getAttribute('data-id') && x.kind === (S.tab === 'apps' ? 'app' : 'fiddle'); })[0]; };
        var i = parseInt(node.getAttribute('data-i'), 10);

        switch (act) {
            case 'tab': {
                var t = node.getAttribute('data-tab');
                if (t === 'fiddles' || t === 'apps') openList(t);
                else if (t === 'stats') { S.tab = 'stats'; render(); loadTop().then(render); }
                else if (t === 'review') openReview();
                else if (t === 'admin') openAdmin();
                else { S.tab = t; render(); }
                return;
            }
            case 'send-code': sendCode(); return;
            case 'change-email': S.codeSent = false; S.code = ''; S.error = null; S.devCode = null; render(); return;
            case 'refresh': refresh().then(render); return;
            case 'save-name': saveName(); return;
            case 'signout': signOut(); return;
            case 'delete-account': deleteAccount(); return;
            case 'filter': S.filter = node.getAttribute('data-filter'); render(); return;
            case 'import': importItem(); return;
            case 'copy-link': copyText(publicUrl(byId())); return;
            case 'pin': togglePin(byId()); return;
            case 'submit': submit(byId()); return;
            case 'withdraw': withdraw(byId()); return;
            case 'remove-item': removeItem(byId()); return;
            case 'publish': publish(node.getAttribute('data-id'), false); return;
            case 'publish-aot': publish(node.getAttribute('data-id'), true); return;
            case 'publish-server': publishServer(node.getAttribute('data-id')); return;
            case 'republish': publish(node.getAttribute('data-id'), false); return;
            case 'republish-aot': publish(node.getAttribute('data-id'), true); return;
            case 'unpublish': unpublish(S.apps.filter(function (a) { return a.id === node.getAttribute('data-id'); })[0]); return;
            case 'approve': review(S.subs[i], true); return;
            case 'reject': review(S.subs[i], false); return;
            case 'ignore-report': ignoreReported(S.reports[i]); return;
            case 'remove-report': removeReported(S.reports[i]); return;
            case 'ban-report': banReported(S.reports[i]); return;
            case 'add-user': addUser(); return;
            case 'reload-users': loadUsers().then(render); return;
            case 'save-user': saveUser(S.rows[i]); return;
            case 'ban-user': banUser(S.rows[i]); return;
            case 'delete-user': deleteUser(S.rows[i]); return;
            case 'seed': requestSeed(); return;
            case 'export-backup': exportBackup(); return;
            case 'run-rollup': runRollup(); return;
            case 'stats-by': S.statsBy = node.getAttribute('data-by'); render(); loadTop().then(render); return;
            case 'reload-stats': loadTop().then(render); return;
        }
    });

    document.addEventListener('input', function (e) {
        var t = e.target;
        if (t.id === 'fa-email') {
            S.email = t.value;
            var b = document.querySelector('[data-act="send-code"]');
            if (b) b.disabled = S.busy || !S.email.trim();
            return;
        }
        if (t.id === 'fa-code') {
            // The mail shows the code as "123 456": keep the digits of whatever is pasted.
            S.code = (t.value || '').replace(/\D/g, '').slice(0, 6);
            if (t.value !== S.code) t.value = S.code;
            if (S.code.length === 6) verify();
            return;
        }
        if (t.id === 'fa-name') {
            S.name = t.value;
            var s = document.querySelector('[data-act="save-name"]');
            if (s) s.disabled = S.busy || S.name.trim() === ((S.user && S.user.name) || '');
            return;
        }
        if (t.id === 'fa-import') {
            S.importText = t.value;
            var a = document.querySelector('[data-act="import"]');
            if (a) a.disabled = S.busy || !extractId(S.importText);
            return;
        }
        if (t.id === 'fa-new-email') {
            S.newEmail = t.value;
            var n = document.querySelector('[data-act="add-user"]');
            if (n) n.disabled = S.busy || !S.newEmail.trim();
            return;
        }
        if (t.id === 'fa-new-plan') { S.newPlan = t.value; return; }
        // Admin table cells and library titles are edited in place; keep the model in step so a
        // re-render (any other action) does not throw the typing away.
        var row = t.getAttribute('data-row');
        if (row !== null) {
            var r = S.rows[parseInt(row, 10)], f = t.getAttribute('data-field');
            if (!r) return;
            if (f === 'expiresDate') r.expiresDate = t.value;
            else if (f === 'maxMb') r.maxMb = t.value === '' ? '' : Number(t.value);
            else if (f === 'maxApps' || f === 'maxPubMonth') r.edit[f] = t.value === '' ? null : Number(t.value);
            else r.edit[f] = t.value;
            return;
        }
        var titleFor = t.getAttribute('data-title-for');
        if (titleFor) {
            var it = S.items.filter(function (x) { return x.id === titleFor; })[0];
            if (it) it.title = t.value;
        }
    });

    document.addEventListener('change', function (e) {
        var t = e.target;
        if (t.id === 'fa-import-backup' && t.files && t.files[0]) { importBackup(t.files[0]); t.value = ''; return; }
        if (t.id === 'fa-new-plan') { S.newPlan = t.value; return; }
        var row = t.getAttribute('data-row');
        if (row !== null && t.tagName === 'SELECT') {
            var r = S.rows[parseInt(row, 10)];
            if (r) r.edit[t.getAttribute('data-field')] = t.value;
            return;
        }
        // Title is saved on blur/change, like the Blazor @bind:after did.
        var titleFor = t.getAttribute('data-title-for');
        if (titleFor) {
            var it = S.items.filter(function (x) { return x.id === titleFor; })[0];
            if (it) saveTitle(it, t.value);
        }
    });

    document.addEventListener('keydown', function (e) {
        if (!S.open) return;
        if (e.target.id === 'fa-email' && e.key === 'Enter') { sendCode(); return; }
        if (e.target.id === 'fa-import' && e.key === 'Enter') { importItem(); return; }
        if (e.key === 'Escape' && e.target.tagName !== 'INPUT') { S.open = false; render(); changed(); }
    });

    // A thumbnail that 404s falls back to the empty placeholder, like the Blazor panel did.
    document.addEventListener('error', function (e) {
        var id = e.target && e.target.getAttribute && e.target.getAttribute('data-fa-thumb');
        if (!id || S.noThumb[id]) return;
        S.noThumb[id] = true;
        if (S.open) render();
    }, true);

    // ---------------------------------------------------------------- public

    // /login is a real page (worker-rendered, indexable) that shows this panel. Opening or
    // closing it in place moves the URL to match, so the address bar, Back and a copied link all
    // agree — the same contract as /show/{id} on the feed.
    var loginReturn = null;
    var prevUrl = location.pathname + location.search + location.hash;

    // The URL is the source of truth: at /login the panel is open, anywhere else it is closed.
    // Called after every history change (ours, landing.js's link handling, Back/Forward).
    function syncPanelToPath() {
        var want = location.pathname.replace(/\/+$/, '') === '/login';
        // Remember where the visitor came from on the way IN — the header link opens the panel
        // (landing.js) a tick before the URL lands here, so this cannot hang off S.open changing.
        if (want) {
            if (loginReturn === null && prevUrl.replace(/\/+$/, '') !== '/login') loginReturn = prevUrl;
        } else {
            loginReturn = null;
        }
        if (want !== !!S.open) { S.open = want; S.error = null; render(); changed(); }
        prevUrl = location.pathname + location.search + location.hash;
    }
    ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        history[m] = function () { var r = orig.apply(this, arguments); setTimeout(syncPanelToPath, 0); return r; };
    });
    window.addEventListener('popstate', function () { setTimeout(syncPanelToPath, 0); });

    // Closing moves the URL off /login, back to wherever the panel was opened from.
    function leaveLogin() {
        if (location.pathname.replace(/\/+$/, '') !== '/login') return;
        history.pushState(null, '', loginReturn || '/');
    }

    function renderButton() {
        var b = document.getElementById('fx-account');
        if (b) b.textContent = S.user ? 'Account' : 'Login';
    }
    listeners.push(renderButton);

    var pub = {
        API: API,
        api: api,
        restore: restore,
        refresh: refresh,
        user: function () { return S.user; },
        token: function () { return S.token; },
        isAdmin: isAdmin,
        isPremium: isPremium,
        isOpen: function () { return S.open; },
        onChange: function (f) { listeners.push(f); },
        open: function (tab) {
            S.open = true; S.error = null;
            if (tab && S.user) {
                if (tab === 'fiddles' || tab === 'apps') { openList(tab); return; }
                S.tab = tab;
            }
            if (S.user && (S.tab === 'fiddles' || S.tab === 'apps')) { openList(S.tab); return; }
            if (S.user && isAdmin()) { render(); loadSubmissions().then(loadReports).then(render); return; }
            render();
        },
        close: function () { S.open = false; render(); changed(); leaveLogin(); },
        // The editor registers this so its Admin tab can still seed (needs Roslyn), and reports
        // progress back through it.
        setSeedStatus: function (text) { S.seedStatus = text; if (S.open && S.tab === 'admin') render(); }
    };

    // The editor mirrors this session (FiddleSession.BindJsAsync) so its premium actions and
    // share auto-save follow whoever is signed in here, and so the Admin tab can still seed.
    window.fiddleBindSession = function (dotnet) {
        listeners.push(function () { try { dotnet.invokeMethodAsync('JsSessionChanged'); } catch (e) { } });
        window.fiddleRequestSeed = function () { try { dotnet.invokeMethodAsync('JsRequestSeed'); } catch (e) { } };
    };

    // Restore on load so the header button is right on every route, editor included, long
    // before the runtime is up. landing.js awaits the same call; a second one is a no-op fetch.
    function start() {
        restore().then(function () {
            renderButton();
            // Landed on /login itself: the live panel replaces the server-rendered copy.
            syncPanelToPath();
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    return pub;
})();
