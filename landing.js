// Landing page (/ and /community) without .NET.
//
// This is the whole landing: feed, card popup, voting, tag editing, moderation, sign-in.
// It used to be FiddleCommunity.razor, which meant a visitor downloaded the .NET runtime and
// the Roslyn compiler (~15.8 MB brotli) before the page became usable — and before a "Login"
// button even existed. The markup and every fc-*/fx-*/fa-* class are the ones already in
// index.html, so what the worker injects for crawlers and what this renders stay the same page.
//
// The account panel (my fiddles, my apps, publishing, review, moderation) lives in account.js
// and opens right here — signing in or managing a library never loads the runtime.
(function () {
    'use strict';

    // account.js owns the session and the account panel; this file only reads the user.
    var FX = window.FiddleAccount;
    var API = FX.API;
    var api = FX.api;
    var user = FX.user;
    var PAGE = 24;

    var S = {
        items: null, mine: {}, owned: {}, reported: {}, noThumb: {},
        more: false, busy: false, error: null,
        sort: 'new', kind: 'all', tag: '', tags: [],
        open: null, tagEdit: null, copied: null,
        contribute: false
    };

    // ---------------------------------------------------------------- helpers

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function el(id) { return document.getElementById(id); }
    function key(it) { return it.id + ':' + it.kind; }
    function name(it) { return (it.title && it.title.trim()) ? it.title : it.id; }
    function tagList(it) { return it.tags ? String(it.tags).split(',').filter(Boolean) : []; }
    function stars(avg) { var n = Math.round(avg || 0); return '★'.repeat(n) + '☆'.repeat(5 - n); }
    function mineOf(it) { return S.mine[key(it)] || 0; }
    function isAdmin() { return FX.isAdmin(); }
    function canEdit(it) { return isAdmin() || !!S.owned[key(it)]; }

    function indexOf(it) {
        if (!S.items) return -1;
        for (var i = 0; i < S.items.length; i++) if (key(S.items[i]) === key(it)) return i;
        return -1;
    }
    function find(id, kind) {
        if (!S.items) return null;
        for (var i = 0; i < S.items.length; i++) if (S.items[i].id === id && S.items[i].kind === kind) return S.items[i];
        return null;
    }
    function thumbSrc(it) {
        return API + '/f/' + encodeURIComponent(it.id) + '/og.png' + (it.thumb ? '?v=' + it.thumb : '');
    }
    // Where "Run" goes — mirrors CommunityItem.RunUrl: a published build always beats the player.
    function runUrl(it) {
        return it.server === 1 ? 'https://live.fiddle.drawnui.net/x/' + it.id
            : it.wasm === 1 ? API + '/a/' + it.id + '/'
                : API + '/p/' + it.id;
    }
    function runTitle(it) {
        return it.server === 1 ? 'Open the published server app — renders on our server, starts instantly, nothing to download.'
            : it.wasm === 1 ? 'Open the published standalone app — prebuilt, boots without the C# compiler.'
                : 'Play in a new tab — canvas only, no editor. Compiles in your browser. Nothing is added to your account.';
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

    // ---------------------------------------------------------------- feed

    async function load(offset) {
        S.busy = true;
        var q = '/api/community?sort=' + S.sort + '&kind=' + S.kind + '&offset=' + offset + '&limit=' + PAGE
            + (S.tag ? '&tag=' + encodeURIComponent(S.tag) : '');
        var r = await api('GET', q);
        S.busy = false;
        if (!r.ok) { if (!S.items) S.error = r.error; return; }
        var v = r.value || {};
        S.mine = v.mine || {};
        S.owned = {};
        (v.owned || []).forEach(function (k) { S.owned[k] = true; });
        S.more = (v.items || []).length === PAGE;
        S.items = offset === 0 ? (v.items || []) : (S.items || []).concat(v.items || []);
        S.error = null;
    }

    async function loadTags() {
        var r = await api('GET', '/api/community/tags');
        if (r.ok) { S.tags = (r.value && r.value.tags) || []; renderTags(); }
    }

    async function filter(sort, kind) { S.sort = sort; S.kind = kind; await load(0); render(); }
    async function selectTag(tag) { S.tag = tag; await load(0); render(); }
    async function loadMore() {
        if (!S.more || S.busy) return;
        await load((S.items || []).length);
        render();
    }

    // ---------------------------------------------------------------- render: grid

    function thumbHtml(it) {
        return S.noThumb[it.id]
            ? '<div class="fc-thumb none">{ }</div>'
            : '<img class="fc-thumb" src="' + esc(thumbSrc(it)) + '" alt="" loading="lazy" data-thumb="' + esc(it.id) + '">';
    }

    function cardHtml(it) {
        return '<button class="fc-card" data-id="' + esc(it.id) + '" data-kind="' + esc(it.kind) + '" data-act="open">' +
            thumbHtml(it) +
            '<div class="fc-body">' +
            '<span class="fc-name">' + esc(name(it)) + '</span>' +
            (it.description && it.description !== it.title ? '<span class="fc-desc">' + esc(it.description) + '</span>' : '') +
            (it.author ? '<span class="fc-author">by ' + esc(it.author) + '</span>' : '') +
            tagList(it).map(function (x) { return '<span class="fc-tag">' + esc(x) + '</span>'; }).join('') +
            (it.official === 1 ? '<span class="fc-kind official">preset</span>' : '') +
            '<span class="fc-kind ' + esc(it.kind) + '">' + esc(it.kind) + '</span>' +
            '<span class="fc-stars">' + stars(it.avg) + '<small>' + (it.votes || 0) + '</small></span>' +
            '</div></button>';
    }

    function render() {
        renderTabs();
        renderTags();          // the active tag pill is part of the same state as the grid
        var host = el('fx-feed-body');
        if (!host) return;
        if (S.error) { host.innerHTML = '<p class="fc-err">' + esc(S.error) + '</p>'; return; }
        if (!S.items) { host.innerHTML = '<p class="fc-empty">Loading…</p>'; return; }
        if (!S.items.length) {
            host.innerHTML = '<p class="fc-empty">Nothing here yet. Submit one of your fiddles from your account to be the first.</p>';
            return;
        }
        host.innerHTML =
            '<div class="fc-grid" data-testid="fiddle-community">' + S.items.map(cardHtml).join('\n') + '</div>' +
            '<div class="fc-sentinel" id="fx-sentinel">' + (S.more && S.busy ? 'Loading…' : '') + '</div>';
        watchEnd();
    }

    function renderTabs() {
        var box = el('fx-tabs');
        if (!box) return;
        var on = function (s) { return S.sort === s && S.kind === 'all' ? ' class="on"' : ''; };
        box.innerHTML =
            '<button' + on('top') + ' data-act="sort" data-sort="top">Top</button>' +
            '<button' + on('new') + ' data-act="sort" data-sort="new">New</button>';
    }

    function renderTags() {
        var box = el('fx-tagbar');
        if (!box) return;
        // Nothing to draw yet: leave whatever the worker injected alone rather than emptying the
        // bar and collapsing it, which would shift the gallery under it.
        if (!S.tags.length) {
            if (box.children.length) return;
            box.innerHTML = ''; box.hidden = true; return;
        }
        box.hidden = false;
        box.innerHTML = '<button' + (S.tag === '' ? ' class="on"' : '') + ' data-act="tag" data-tag="">All</button>' +
            S.tags.slice(0, 14).map(function (t) {
                return '<button' + (S.tag === t.tag ? ' class="on"' : '') + ' data-act="tag" data-tag="' + esc(t.tag) + '">' +
                    esc(t.tag) + ' <small>' + t.count + '</small></button>';
            }).join('');
    }

    // Infinite scroll: load the next page while the sentinel is still 600px away.
    var endObserver = null;
    function watchEnd() {
        if (endObserver) { endObserver.disconnect(); endObserver = null; }
        var sentinel = el('fx-sentinel');
        if (!sentinel || !S.more || !('IntersectionObserver' in window)) return;
        endObserver = new IntersectionObserver(function (entries) {
            if (entries.some(function (e) { return e.isIntersecting; })) loadMore();
        }, { rootMargin: '600px 0px' });
        endObserver.observe(sentinel);
    }

    // ---------------------------------------------------------------- render: card popup

    function popHtml(it) {
        var mine = mineOf(it);
        var i = indexOf(it);
        var editable = canEdit(it);
        var tags = tagList(it);

        var tagsRow = '';
        if (tags.length || editable) {
            tagsRow = '<p class="fc-pop-tags" data-testid="fiddle-community-pop-tags">' +
                tags.map(function (t) {
                    return '<button class="fc-tag" title="Show everything tagged ' + esc(t) + '" data-act="pop-tag" data-tag="' + esc(t) + '">' + esc(t) + '</button>';
                }).join('') +
                (!editable ? ''
                    : S.tagEdit === null
                        ? '<button class="fc-ghost fc-sm" data-act="tags-edit">' + (tags.length ? 'Edit tags' : 'Add tags') + '</button>'
                        : '<input class="fc-tag-input" id="fx-tag-input" placeholder="chart, dashboard (max 5)" maxlength="110" value="' + esc(S.tagEdit) + '" data-testid="fiddle-community-tag-input">' +
                          '<button class="fc-open fc-sm" data-act="tags-save"' + (S.busy ? ' disabled' : '') + '>Save</button>' +
                          '<button class="fc-ghost fc-sm" data-act="tags-cancel">Cancel</button>') +
                '</p>';
        }

        var vote = user()
            ? '<span class="fc-vote-stars" data-testid="fiddle-community-vote">' +
                [1, 2, 3, 4, 5].map(function (n) {
                    return '<button' + (n <= mine ? ' class="on"' : '') + ' title="' + n + ' star' + (n > 1 ? 's' : '') +
                        '" data-act="rate" data-n="' + n + '"' + (S.busy ? ' disabled' : '') + '>★</button>';
                }).join('') + '</span>' +
              '<span class="fc-vote-hint">' + (mine > 0 ? 'Your vote: ' + mine + '. Click it again to remove.' : 'Rate it') + '</span>'
            : '<button class="fc-ghost" data-act="signin">Sign in to vote</button>';

        var actions =
            (it.kind === 'app'
                ? '<a class="fc-open" href="' + esc(runUrl(it)) + '" target="_blank" rel="noopener" title="' + esc(runTitle(it)) + '">Run App</a>'
                : '<a class="fc-open" href="/app#id=' + esc(it.id) + '" title="Loads the source into the editor and compiles it in your browser" data-testid="fiddle-community-open">Editor</a>' +
                  '<a class="fc-open green" href="' + esc(runUrl(it)) + '" target="_blank" rel="noopener" title="' + esc(runTitle(it)) + '" data-testid="fiddle-community-run">▶ Run</a>') +
            '<button class="fc-open pink" title="Copy this fiddle&#39;s existing share link (fiddle.drawnui.net/f/…). Nothing is created or added to your account." data-act="copy" data-testid="fiddle-community-share">' +
                (S.copied === key(it) ? 'Copied ✓' : 'Share') + '</button>' +
            (editable ? '<button class="fc-ghost danger" title="Take it off the Community page" data-act="remove"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-community-remove">Remove</button>' : '') +
            (isAdmin()
                ? '<span class="fc-weight" title="Order among items with the same rating" data-testid="fiddle-community-weight">' +
                    '<button class="fc-ghost" data-act="weight" data-d="-1"' + (S.busy ? ' disabled' : '') + '>▼</button>' +
                    '<span>' + (it.weight || 0) + '</span>' +
                    '<button class="fc-ghost" data-act="weight" data-d="1"' + (S.busy ? ' disabled' : '') + '>▲</button>' +
                  '</span>' +
                  '<button class="fc-ghost danger" title="Hide for good and block re-advertising" data-act="ban"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-community-ban">Ban</button>' +
                  (it.official !== 1
                      ? '<button class="fc-ghost danger" title="Suspend the author&#39;s account: sign-in refused, all their listings unlisted" data-act="ban-author"' + (S.busy ? ' disabled' : '') + ' data-testid="fiddle-community-ban-author">Ban author</button>'
                      : '')
                : '') +
            '<button class="fc-ghost" data-act="report"' + (S.busy || S.reported[key(it)] ? ' disabled' : '') + ' data-testid="fiddle-community-report">' +
                (S.reported[key(it)] ? 'Reported ✓' : 'Report') + '</button>' +
            '<button class="fc-ghost" data-act="close-pop">Close</button>';

        return '<div class="fc-overlay" id="fx-pop-overlay" tabindex="0" data-act="close-pop">' +
            '<div class="fc-pop-wrap" data-stop="1">' +
            '<button class="fc-nav prev" title="Previous (←)" data-act="step" data-d="-1"' + (i <= 0 ? ' disabled' : '') + ' data-testid="fiddle-community-prev">‹</button>' +
            '<button class="fc-nav next" title="Next (→)" data-act="step" data-d="1"' +
                ((!S.more && i >= (S.items ? S.items.length : 0) - 1) ? ' disabled' : '') + ' data-testid="fiddle-community-next">›</button>' +
            '<div class="fc-pop" data-testid="fiddle-community-pop">' +
            '<button class="fc-close" data-act="close-pop" aria-label="Close">✕</button>' +
            thumbHtml(it) +
            '<div class="fc-pop-body">' +
            '<h2 class="fc-pop-title">' + esc(name(it)) + ' ' +
                (it.official === 1 ? '<span class="fc-kind official">preset</span> ' : '') +
                '<span class="fc-kind ' + esc(it.kind) + '">' + esc(it.kind) + '</span></h2>' +
            (it.description && it.description !== it.title ? '<p class="fc-pop-desc">' + esc(it.description) + '</p>' : '') +
            tagsRow +
            '<p class="fc-pop-meta">' + (it.author ? 'by ' + esc(it.author) + ' · ' : '') + stars(it.avg) + ' ' +
                (it.avg || 0).toFixed(1) + ' · ' + (it.votes || 0) + ' ' + (it.votes === 1 ? 'vote' : 'votes') + ' · ' + esc(it.id) + '</p>' +
            '<div class="fc-vote">' + vote + '</div>' +
            '<div class="fc-actions">' + actions + '</div>' +
            '</div></div></div></div>';
    }

    function contributeHtml() {
        return '<div class="fc-overlay" data-act="close-contribute">' +
            '<div class="fc-pop fc-pop-text" data-testid="fiddle-contribute-pop" data-stop="1">' +
            '<button class="fc-close" data-act="close-contribute" aria-label="Close">✕</button>' +
            '<div class="fc-pop-body">' +
            '<h2 class="fc-pop-title">Contribute to the Community</h2>' +
            '<p class="fc-pop-desc">Built something worth showing? Put it on this page — people open it, rate it and learn from it.</p>' +
            '<ol class="fc-steps">' +
            '<li><b>Sign in</b> — free, just an email code. Your shares get a home in <b>My fiddles</b>.</li>' +
            '<li>In the editor use <b>Export Web → Share as Fiddle</b> (or Share as App). Give it a short description — that&#39;s the card text.</li>' +
            '<li>Open <b>Account → My fiddles</b> and hit <b>Submit to Community</b>. A moderator takes a look, then it&#39;s live here.</li>' +
            '</ol>' +
            '<p class="fc-pop-desc" style="font-size:13px;opacity:.8">House rules: your own code, nothing offensive or illegal, keep it working. Full text in the <a href="/terms/" style="color:#8fd0ff">Terms</a>.</p>' +
            '<div class="fc-actions">' +
            (user()
                ? '<button class="fc-open" data-act="library" data-testid="fiddle-contribute-library">Open My fiddles</button>'
                : '<button class="fc-open" data-act="signin" data-testid="fiddle-contribute-signin">Sign in</button>') +
            '<a class="fc-ghost" href="/app">Open editor</a>' +
            '</div></div></div></div>';
    }

    function renderPop() {
        var host = el('fx-modals');
        if (!host) return;
        host.innerHTML = (S.open ? popHtml(S.open) : '') + (S.contribute ? contributeHtml() : '');
        var input = el('fx-tag-input');
        if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
        else { var ov = el('fx-pop-overlay'); if (ov) ov.focus(); }   // arrow keys need focus on the overlay
    }

    // ---------------------------------------------------------------- render: account button

    function renderAccountBtn() {
        var b = el('fx-account');
        if (b) b.textContent = user() ? 'Account' : 'Login';
    }

    // ---------------------------------------------------------------- actions

    async function rate(it, n) {
        S.busy = true; renderPop();
        var r = await api('PUT', '/api/community/' + it.id + '/rate?kind=' + it.kind, { stars: n });
        S.busy = false;
        if (!r.ok) { S.error = r.error; renderPop(); return; }
        it.votes = r.value.votes; it.avg = r.value.avg; it.score = r.value.score;
        if (n === 0) delete S.mine[key(it)]; else S.mine[key(it)] = n;
        renderPop(); render();
    }

    async function saveTags(it) {
        S.busy = true; renderPop();
        var r = await api('PUT', '/api/community/' + it.id + '/tags?kind=' + it.kind, { tags: S.tagEdit || '' });
        S.busy = false;
        if (!r.ok) { S.error = r.error; renderPop(); return; }
        it.tags = r.value.tags; S.tagEdit = null;
        renderPop(); render(); loadTags();
    }

    async function remove(it) {
        S.busy = true;
        var r = await api('DELETE', '/api/community/' + it.id + '?kind=' + it.kind);
        S.busy = false;
        if (!r.ok) { S.error = r.error; renderPop(); return; }
        var i = indexOf(it);
        if (i >= 0) S.items.splice(i, 1);
        delete S.owned[key(it)];
        S.open = null; renderPop(); render();
    }

    async function weight(it, d) {
        S.busy = true; renderPop();
        var r = await api('PUT', '/api/community/' + it.id + '/weight?kind=' + it.kind, { delta: d });
        if (!r.ok) { S.busy = false; S.error = r.error; renderPop(); return; }
        it.weight = r.value.weight;
        await load(0);                                   // re-fetch so the grid reflects the new order
        var i = indexOf(it);
        S.open = i >= 0 ? S.items[i] : it;
        S.busy = false;
        renderPop(); render();
    }

    async function ban(it) {
        if (!confirm('Ban "' + name(it) + '" from the Community? It cannot be re-advertised.')) return;
        S.busy = true;
        var r = await api('PUT', '/api/community/' + it.id + '/ban?kind=' + it.kind);
        S.busy = false;
        if (!r.ok) { S.error = r.error; renderPop(); return; }
        var i = indexOf(it);
        if (i >= 0) S.items.splice(i, 1);
        S.open = null; renderPop(); render();
    }

    async function banAuthor(it) {
        if (!confirm('Suspend the account that listed "' + name(it) + '"? Sign-in refused, all their listings unlisted, display name cleared.')) return;
        S.busy = true;
        var r = await api('PUT', '/api/community/' + it.id + '/ban-author?kind=' + it.kind);
        S.busy = false;
        if (!r.ok) { S.error = r.error; renderPop(); return; }
        S.open = null;
        await load(0);
        renderPop(); render();
    }

    async function report(it) {
        var reason = prompt("What's wrong with it? (optional)", '');
        if (reason === null) return;                     // cancelled
        S.busy = true;
        var r = await api('POST', '/api/community/' + it.id + '/report?kind=' + it.kind, { reason: reason });
        S.busy = false;
        if (!r.ok) { S.error = r.error; renderPop(); return; }
        S.reported[key(it)] = true; renderPop();
    }

    async function step(d) {
        if (!S.open || !S.items) return;
        var i = indexOf(S.open) + d;
        if (i >= S.items.length && S.more) { await load(S.items.length); render(); }
        if (i < 0 || i >= S.items.length) return;
        S.open = S.items[i]; S.tagEdit = null;
        renderPop();
        // Arrows move the URL with the card, so what you are looking at is always what you would
        // share. replaceState, not pushState: pushing would make Back walk the cards you browsed
        // one by one instead of returning to the feed.
        if (showId(location.pathname.replace(/\/+$/, '')) !== null) {
            history.replaceState(null, '', '/show/' + S.open.id);
        }
    }

    // ---------------------------------------------------------------- events

    document.addEventListener('click', function (e) {
        var node = e.target.closest ? e.target.closest('[data-act]') : null;
        if (!node) return;
        var act = node.getAttribute('data-act');

        // Overlay backdrops carry a close action; the card inside carries data-stop. A click on
        // the card bubbles up to the backdrop, so ignore it unless the matched node IS inside
        // the card (the ✕ and Close buttons are).
        if (act.indexOf('close-') === 0) {
            var stop = e.target.closest('[data-stop]');
            if (stop && node.contains(stop)) return;
        }

        var it = S.open;
        switch (act) {
            case 'open': {
                e.preventDefault();
                var found = find(node.getAttribute('data-id'), node.getAttribute('data-kind'));
                if (found) {
                    S.open = found; S.tagEdit = null; renderPop();
                    // The card is a page of its own: give it a URL so it can be shared, linked
                    // and indexed. Back closes it again.
                    history.pushState(null, '', '/show/' + found.id);
                }
                return;
            }
            case 'cancel-open': cancelOpen(); return;
            case 'close-pop':
                S.open = null; S.tagEdit = null; renderPop();
                if (showId(location.pathname.replace(/\/+$/, '')) !== null) history.pushState(null, '', '/');
                return;
            case 'close-contribute': S.contribute = false; renderPop(); return;
            case 'sort': filter(node.getAttribute('data-sort'), 'all'); return;
            case 'tag': {
                // Filter in place and keep the address in step, so /t/{tag} stays linkable and Back
                // still works — without turning the pill into a link, which the stylesheet does not
                // size and which collapsed the bar to nothing.
                var t = node.getAttribute('data-tag');
                history.pushState(null, '', t ? '/t/' + encodeURIComponent(t) : '/');
                selectTag(t);
                return;
            }
            case 'pop-tag': {
                S.open = null; renderPop();
                var pt = node.getAttribute('data-tag');
                history.pushState(null, '', pt ? '/t/' + encodeURIComponent(pt) : '/');
                selectTag(pt);
                return;
            }
            case 'contribute':
                if (user()) FX.open('fiddles');
                else { S.contribute = true; renderPop(); }
                return;
            case 'library': S.contribute = false; renderPop(); FX.open('fiddles'); return;
            case 'account': FX.open(); return;
            case 'signin':
                S.contribute = false; S.open = null; renderPop();
                FX.open();
                return;
        }

        if (!it) return;
        switch (act) {
            case 'step': step(parseInt(node.getAttribute('data-d'), 10)); return;
            case 'rate': {
                var n = parseInt(node.getAttribute('data-n'), 10);
                rate(it, n === mineOf(it) ? 0 : n);
                return;
            }
            case 'tags-edit': S.tagEdit = String(it.tags || '').replace(/,/g, ', '); renderPop(); return;
            case 'tags-cancel': S.tagEdit = null; renderPop(); return;
            case 'tags-save': saveTags(it); return;
            case 'copy': copyText(API + '/f/' + it.id); S.copied = key(it); renderPop(); return;
            case 'remove': remove(it); return;
            case 'weight': weight(it, parseInt(node.getAttribute('data-d'), 10)); return;
            case 'ban': ban(it); return;
            case 'ban-author': banAuthor(it); return;
            case 'report': report(it); return;
        }
    });

    document.addEventListener('input', function (e) {
        if (e.target.id === 'fx-tag-input') S.tagEdit = e.target.value;
    });

    document.addEventListener('keydown', function (e) {
        if (e.target.id === 'fx-tag-input') {
            if (e.key === 'Enter' && !S.busy) saveTags(S.open);
            else if (e.key === 'Escape') { S.tagEdit = null; renderPop(); }
            return;
        }
        if (document.getElementById('fx-loading')) { if (e.key === 'Escape') cancelOpen(); return; }
        if (FX.isOpen()) return;                 // the account panel owns the keyboard while it is up
        if (S.contribute && e.key === 'Escape') { S.contribute = false; renderPop(); return; }
        if (!S.open) return;
        if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
        else if (e.key === 'Escape') { S.open = null; S.tagEdit = null; renderPop(); }
    });

    // A thumbnail that 404s falls back to the "{ }" placeholder, like the Blazor landing did.
    document.addEventListener('error', function (e) {
        var id = e.target && e.target.getAttribute && e.target.getAttribute('data-thumb');
        if (!id || S.noThumb[id]) return;
        S.noThumb[id] = true;
        render();
        if (S.open) renderPop();
    }, true);

    // ---------------------------------------------------------------- editor, in place
    //
    // Opening a fiddle used to be a document navigation, which tears down and re-instantiates
    // the .NET runtime — that is why the loader came back on every single card. The editor now
    // mounts into THIS document: the runtime boots once per session, and every fiddle after the
    // first costs a component mount instead of a 226-assembly boot. Back is instant too, because
    // the landing DOM is never destroyed (and keeps its scroll position).
    //
    // Progressive enhancement: the cards stay real links, so a cold load, a middle click, a
    // bookmark or a failure all behave exactly as before.

    var bootPromise = null;
    var blazorReady = false;
    var feedScroll = 0;          // where the feed was when the editor took over
    var servedUrl = null;        // which fiddle the mounted editor is actually showing
    // We move between the feed and the editor inside one document, so the browser's own scroll
    // restoration would fight us: it remembers a position per history entry and applies it after
    // our handler has already put the page where it belongs.
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    function jumpTo(y) {
        // Instant, never animated — this is a page change, not a scroll.
        try { window.scrollTo({ top: y, left: 0, behavior: 'instant' }); }
        catch (e) { window.scrollTo(0, y); }
    }
    var routingBlazor = false;   // our synthetic popstate is for Blazor's router, not for us

    function bootEditor() {
        if (!bootPromise) {
            bootPromise = window.fxBootEditor()
                .then(function () { blazorReady = true; })
                .catch(function (e) { bootPromise = null; throw e; });
        }
        return bootPromise;
    }

    // Opening a fiddle before the runtime is up: the feed STAYS on screen, dimmed, with a small
    // card saying what is loading. Only once the editor is really there does the page switch.
    // Escape or a click on the dim cancels and puts you back in the feed — the boot carries on in
    // the background, so a second attempt is instant.
    var openSeq = 0;

    function loadingOverlay(show) { window.fxLoadingOverlay(show); }

    function revealEditor() {
        loadingOverlay(false);
        var here = location.pathname + location.hash;
        var alreadyMounted = !!document.querySelector('.fiddle-editor');
        el('fx-land').hidden = true;
        routingBlazor = true;
        try { window.dispatchEvent(new PopStateEvent('popstate')); }   // pushState does not notify Blazor
        finally { routingBlazor = false; }
        // Routing alone is not enough when the editor never unmounted: #id= is a fragment, so
        // Blazor sees the same /app route and leaves the component — and its old fiddle — in place.
        // Tell it to re-read the URL. (This is the bug where the second fiddle you opened after
        // going back to the feed was still the first one.)
        if (alreadyMounted && here !== servedUrl && window.fiddle && window.fiddle.openDeepLink) {
            window.fiddle.openDeepLink();
        }
        servedUrl = here;
        jumpTo(0);               // opening from halfway down the feed must start at the top
    }

    function showEditor() {
        // Whatever was open over the feed belongs to the feed, not to the editor.
        S.open = null; S.contribute = false; S.tagEdit = null;
        renderPop();
        if (FX.isOpen()) FX.close();
        feedScroll = window.scrollY || window.pageYOffset || 0;

        var seq = ++openSeq;
        if (blazorReady) { revealEditor(); return; }

        loadingOverlay(true);
        bootEditor().then(function () {
            if (seq !== openSeq) return;              // cancelled while it was loading
            window.fxWhenEditorDrawn(function () { if (seq === openSeq) revealEditor(); });
        }).catch(function () { location.reload(); });
    }

    function cancelOpen() {
        openSeq++;                                    // whatever is in flight no longer applies
        loadingOverlay(false);
        history.back();                               // popstate puts the feed back where it was
    }

    function isEditorPath(p) { return /^\/(app|fiddle)(\/|$)/.test(p); }
    function isLandingPath(p) { return p === '' || p === '/community' || p === '/login' || showId(p) !== null || tagOf(p) !== null; }
    // /t/{tag}: the catalogue filtered to one tag, with an address of its own.
    function tagOf(p) { var m = /^\/t\/([^/]{1,40})$/.exec(p); return m ? decodeURIComponent(m[1]) : null; }
    function showId(p) { var m = /^\/show\/([A-Za-z0-9]{6,16})$/.exec(p); return m ? m[1] : null; }

    function showLanding() {
        loadingOverlay(false);
        el('fx-land').hidden = false;
        ensureFeed();
    }

    // The feed is fetched the first time it is actually shown. Arriving straight at /app must not
    // pay for a community query the visitor may never look at.
    var feedRequested = false;
    function ensureFeed() {
        if (feedRequested) return Promise.resolve();
        feedRequested = true;
        return load(0).then(function () { render(); loadTags(); return openFromUrl(); });
    }

    // /show/{id} is the index with that card open. If the snippet is not on the first page,
    // widen the query once rather than dropping the visitor on a plain index they did not ask for.
    function openFromUrl() {
        var id = showId(location.pathname.replace(/\/+$/, ''));
        if (id === null) return Promise.resolve();
        var it = (S.items || []).filter(function (x) { return x.id === id; })[0];
        if (it) { S.open = it; S.tagEdit = null; renderPop(); return Promise.resolve(); }
        return api('GET', '/api/community?sort=new&kind=all&offset=0&limit=60').then(function (r) {
            var found = r.ok ? (r.value.items || []).filter(function (x) { return x.id === id; })[0] : null;
            if (found) { S.open = found; S.tagEdit = null; renderPop(); }
        });
    }

    // The DOM has to follow the URL however it changed — our own clicks, the back button, or
    // Blazor routing itself (the header logo is an ordinary link, and Blazor handles those
    // internally with pushState, which fires no event of its own).
    function syncToLocation() {
        var p = location.pathname.replace(/\/+$/, '');
        if (isLandingPath(p)) {
            if (el('fx-land').hidden) { openSeq++; showLanding(); jumpTo(feedScroll); }
            var urlTag = tagOf(p) || '';
            if (feedRequested && urlTag !== S.tag) selectTag(urlTag);
        } else if (isEditorPath(p) && el('fx-land').hidden === false) {
            showEditor();
        }
    }
    ['pushState', 'replaceState'].forEach(function (m) {
        var orig = history[m];
        history[m] = function () {
            var r = orig.apply(this, arguments);
            // Only ever corrects a mismatch, so our own pushState cannot loop back in here.
            setTimeout(syncToLocation, 0);
            return r;
        };
    });

    document.addEventListener('click', function (e) {
        // Anything but a plain left click stays a normal navigation — otherwise open-in-new-tab,
        // middle click and downloads would break.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        var a = e.target.closest ? e.target.closest('a[href]') : null;
        if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
        if (a.getAttribute('data-act') === 'tag') return;   // handled above: filters in place
        var url;
        try { url = new URL(a.getAttribute('href'), location.href); } catch (x) { return; }
        if (url.origin !== location.origin) return;
        var p = url.pathname.replace(/\/+$/, '');
        if (!isEditorPath(url.pathname) && !isLandingPath(p)) return;
        e.preventDefault();
        history.pushState(null, '', url.pathname + url.search + url.hash);
        if (isLandingPath(p)) { openSeq++; showLanding(); jumpTo(feedScroll); }
        else showEditor();
    });

    // Warm the runtime while the visitor is reading the feed, so the first fiddle they open does
    // not start from zero. It boots at "/" where the router renders LandingShell — nothing — so
    // this is invisible. Deliberately delayed: someone who bounces in two seconds never pays for
    // it, and skipped entirely on metered or slow connections.
    function warmEditor() {
        var c = navigator.connection || {};
        if (c.saveData || /(^|-)[23]g$/.test(c.effectiveType || '')) return;
        bootEditor().catch(function () { /* the click path retries and falls back to a reload */ });
    }
    if (window.fxLanding) setTimeout(function () {
        if ('requestIdleCallback' in window) requestIdleCallback(warmEditor, { timeout: 5000 });
        else warmEditor();
    }, 4000);


    window.addEventListener('popstate', function () {
        if (routingBlazor) return;
        var p = location.pathname.replace(/\/+$/, '');
        if (isLandingPath(p)) {
            openSeq++;                      // anything mid-open no longer applies
            showLanding();                  // Blazor empties #app itself
            // Back and Forward move between tag pages too, so the filter follows the URL — without
            // this the address said /t/game while the gallery still showed the previous tag.
            var backTag = tagOf(p) || '';
            if (feedRequested && backTag !== S.tag) { selectTag(backTag); return; }
            if (showId(p) !== null) { openFromUrl(); }
            else if (S.open) { S.open = null; renderPop(); }   // back out of a card
            else { jumpTo(feedScroll); }
        } else {
            showEditor();
        }
    });

    // ---------------------------------------------------------------- start

    async function main() {
        // The worker injects the top cards into index.html and the same items as JSON. Adopt them
        // before any request: the injected grid stays on screen (no blank, no reflow) and clicking
        // a card already opens the popup while the fresh list is still in flight.
        try {
            var seed = document.getElementById('fx-feed-data');
            if (seed && seed.textContent) S.items = JSON.parse(seed.textContent);
        } catch (e) { }
        // Same for the tag bar: the worker rendered it into the page, so adopt its data before the
        // first render. Without this the first renderTags() would find S.tags empty, blank the
        // injected bar and hide it until the API answered — the pop-in, just moved later.
        try {
            var tagSeed = document.getElementById('fx-tags-data');
            if (tagSeed && tagSeed.textContent) S.tags = JSON.parse(tagSeed.textContent);
        } catch (e) { }
        // On /t/{tag} the injected cards are already that tag's slice: adopt the filter before the
        // first fetch, or the client would immediately replace them with the unfiltered feed.
        try {
            var active = document.getElementById('fx-tag-active');
            if (active && active.textContent) S.tag = JSON.parse(active.textContent);
            else S.tag = tagOf(location.pathname.replace(/\/+$/, '')) || S.tag;
        } catch (e) { }
        renderTabs();
        // Restore first, THEN listen: subscribing earlier made the initial restore look like a
        // sign-in, so every visit fetched the feed twice (two loads racing to fill the grid).
        await FX.restore();
        renderAccountBtn();
        var was = user() ? user().email : null;
        // Signing in or out changes what the feed returns (votes, ownership) and the header label.
        FX.onChange(function () {
            renderAccountBtn();
            var now = user() ? user().email : null;
            if (now !== was) { was = now; if (feedRequested) load(0).then(render); }
        });
        // On an editor route the gate has already started the runtime — adopt that promise so a
        // later click knows it is warm. (Done here, not at script scope: landing.js is written out
        // before the block that defines fxBootEditor.)
        if (!window.fxLanding) bootEditor();
        if (!el('fx-land').hidden) await ensureFeed();   // on the editor the feed waits until shown
    }

    // ---------------------------------------------------------------- WebMCP

    // An agentic browser can drive this page directly instead of scraping it: the same three things
    // the MCP server at /mcp offers, wired to the feed that is already in memory. No-op in a normal
    // browser, where navigator.modelContext does not exist.
    function registerWebMcp() {
        var mc = navigator.modelContext;
        if (!mc || typeof mc.registerTool !== 'function') return;
        var tools = [
            {
                name: 'search_snippets',
                description: 'Search the DrawnUI snippet catalogue shown on this page. Returns matching snippets with their ids.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string', description: 'Words to look for in the title, description or tags.' },
                        limit: { type: 'integer', minimum: 1, maximum: 30 }
                    }
                },
                execute: async function (args) {
                    await ensureFeed();
                    var q = String((args && args.query) || '').toLowerCase();
                    var lim = Math.min(30, Math.max(1, (args && args.limit) || 10));
                    var hits = (S.items || []).filter(function (it) {
                        return !q || ((it.title || '') + ' ' + (it.description || '') + ' ' + (it.tags || '')).toLowerCase().indexOf(q) >= 0;
                    }).slice(0, lim);
                    return { content: [{ type: 'text', text: hits.length
                        ? hits.map(function (it) { return '- ' + (it.title || it.id) + ' (id: ' + it.id + ')'; }).join('\n')
                        : 'Nothing matched.' }] };
                }
            },
            {
                name: 'open_snippet',
                description: 'Open one snippet on this page, showing its preview, description and the buttons to run or edit it.',
                inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
                execute: async function (args) {
                    var id = String((args && args.id) || '');
                    await ensureFeed();
                    var it = (S.items || []).filter(function (x) { return x.id === id; })[0];
                    if (!it) return { content: [{ type: 'text', text: 'No snippet ' + id + ' in the catalogue.' }] };
                    history.pushState(null, '', '/show/' + id);
                    S.open = it; S.tagEdit = null; renderPop();
                    return { content: [{ type: 'text', text: 'Opened "' + (it.title || id) + '". Source: /c/' + id + '.md' }] };
                }
            },
            {
                name: 'get_snippet_source',
                description: 'Return the C# source of a snippet by id.',
                inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
                execute: async function (args) {
                    var id = String((args && args.id) || '');
                    if (!/^[A-Za-z0-9]{6,16}$/.test(id)) return { content: [{ type: 'text', text: 'Not a snippet id.' }] };
                    var r = await fetch('/c/' + id + '.md');
                    return { content: [{ type: 'text', text: r.ok ? await r.text() : 'No snippet ' + id + '.' }] };
                }
            }
        ];
        try { tools.forEach(function (t) { mc.registerTool(t); }); } catch (e) { /* shape still moving; never break the page over it */ }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { main(); registerWebMcp(); });
    else { main(); registerWebMcp(); }
})();
