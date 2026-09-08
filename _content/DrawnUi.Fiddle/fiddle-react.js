// TSX snippets: transpile, run, mount. The C# path goes through Roslyn on WebAssembly; this is the
// same shape for the other language — same "a body that returns a control" contract, same error
// list, same canvas pane — but the compiler is Monaco's TypeScript service and the engine is
// DrawnUi.React on CanvasKit.
//
// Nothing here loads until a React snippet is actually run: the runtime bundle and CanvasKit are
// several megabytes and a C# visitor must never pay for them.
(function () {
    var RUNTIME = 'react/drawnui-react.js';   // relative to <base href>
    var ready = null;                          // the one-time boot promise
    var root = null;                           // the React root mounted in the canvas pane
    var rootHost = null;                       // the pane that root belongs to
    var view = null;                           // the engine Canvas behind it, for screenshots
    var logs = [];

    function loadScript(src) {
        return new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = new URL(src, document.baseURI).href;
            s.onload = resolve;
            s.onerror = function () { reject(new Error('could not load ' + src)); };
            document.head.appendChild(s);
        });
    }

    // The engine boots once per page: CanvasKit and the fonts are shared by every run.
    function boot() {
        if (ready) return ready;
        ready = (async function () {
            if (!window.DrawnUi || !window.DrawnUi.Super) await loadScript(RUNTIME);
            // AddEmojis()/AddSymbols() fetch their subsets from here; they ship next to the runtime.
            window.DrawnUi.FontCollection.ContentRoot = 'react/fonts/';
            await window.DrawnUi.Super.UseDrawnUi()
                .ConfigureFonts(function (fonts) {
                    // The same families the C# app registers (Program.cs), under the same names, so a
                    // snippet reads the same in both languages: FontText, FontTextTitle, plus the
                    // shipped emoji and symbol subsets - without them those glyphs draw as nothing.
                    // TEXT FIRST: the engine takes the first registered face as the default, so
                    // registering the emoji subset before OpenSans left every label without an
                    // explicit FontFamily drawing nothing at all.
                    return fonts
                        .AddFont('fonts/OpenSans-Regular.ttf', 'FontText')
                        .AddFont('fonts/OpenSans-Semibold.ttf', 'FontText', 600)
                        .AddFont('fonts/OpenSans-Semibold.ttf', 'FontTextTitle')
                        .AddSymbols()
                        .AddEmojis();
                })
                // The app's own default font, exactly as FiddleApp/Program.cs registers it for the
                // C# side. Both engines resolve an EMPTY FontFamily to the Skia built-in face, so a
                // host that wants its own font everywhere has to say so; without this every label
                // that does not name a family would draw in a face the fiddle never registered.
                .ConfigureStyles(function (styles) {
                    styles.AddStyle({
                        TargetType: window.DrawnUiCore.SkiaLabel,
                        ApplyToDerivedTypes: true,
                        Setters: { FontFamily: 'FontText' },
                    });
                })
                .BuildAsync();
        })();
        return ready;
    }

    // Monaco already ships the TypeScript service — the same worker that powers ts/js IntelliSense.
    // classic JSX (React.createElement) is deliberate: the react-jsx transform emits an import of
    // "react/jsx-runtime", and a bare specifier cannot be resolved without a bundler.
    // Setting the options is what respawns the TypeScript worker, and the worker is a 5.6 MB module:
    // doing it per run re-downloaded it every single time. Once per page is enough.
    var tsConfigured = false;

    // IntelliSense: the package's own declarations, served as a virtual file system Monaco's
    // TypeScript service can resolve. Completion inside a snippet is then the real prop list of the
    // real control, and it cannot drift from the engine — it IS the engine's .d.ts.
    var typesLoaded = null;
    var typesOk = false;

    function loadTypes() {
        if (typesLoaded) return typesLoaded;
        typesLoaded = (async function () {
            var res = await fetch(new URL('react/types.json', document.baseURI).href);
            if (!res.ok) return;                    // completion is a nicety; running is not
            var bundle = await res.json();
            var ts = window.monaco.languages.typescript;
            Object.keys(bundle.files).forEach(function (path) {
                ts.typescriptDefaults.addExtraLib(bundle.files[path], path);
            });
            typesOk = true;
        })().catch(function () { });
        return typesLoaded;
    }

    function tsDefaults() {
        var ts = window.monaco.languages.typescript;
        if (tsConfigured) return ts;
        tsConfigured = true;
        loadTypes();
        ts.typescriptDefaults.setCompilerOptions({
            target: ts.ScriptTarget.ES2020,
            jsx: ts.JsxEmit.React,
            // Node resolution + these paths are what make "drawnui-react" and "react" resolve to
            // the declarations above, so the globals file can borrow their types.
            moduleResolution: ts.ModuleResolutionKind.NodeJs,
            baseUrl: 'file:///',
            paths: {
                'drawnui-react': ['node_modules/drawnui-react/dist/react/index'],
                'drawnui-react/core': ['node_modules/drawnui-react/dist/index'],
                react: ['node_modules/@types/react/index'],
            },
            esModuleInterop: true,
            allowSyntheticDefaultImports: true,
            // A snippet is a MODULE, not a loose script: as a script it shared one global scope
            // with the editor's own model and every const in it was reported as a redeclaration.
            module: ts.ModuleKind.ESNext,
            allowNonTsExtensions: true,
            noEmitOnError: false,
            skipLibCheck: true,
        });
        return ts;
    }

    function messageOf(d) {
        var m = d.messageText;
        while (m && typeof m !== 'string') m = m.messageText;
        return m || 'error';
    }

    // Diagnostics carry a character offset; the fiddle speaks editor line numbers, like Roslyn's.
    function lineOf(code, start) {
        return code.slice(0, start || 0).split('\n').length;
    }

    // What the last transpile produced, so sharing a snippet can send the module along instead of
    // compiling it a second time.
    var lastEmit = { code: null, js: null };

    async function transpile(code) {
        var monaco = window.monaco, ts = tsDefaults();
        await loadTypes();
        var uri = monaco.Uri.parse('inmemory://fiddle/snippet.tsx');
        var model = monaco.editor.getModel(uri) || monaco.editor.createModel(code, 'typescript', uri);
        model.setValue(code);
        var client = await (await ts.getTypeScriptWorker())(uri);
        var syntax = await client.getSyntacticDiagnostics(uri.toString());
        var semantic = await client.getSemanticDiagnostics(uri.toString());
        // Only a SYNTAX error stops a run, exactly as TypeScript itself behaves: tsc emits through
        // type errors, and blocking on them here would make the fiddle stricter than the language.
        // Type complaints still appear as squiggles in the editor, and travel back as warnings.
        var where = function (d) { return 'L' + lineOf(code, d.start) + ': ' + messageOf(d); };
        var errors = syntax.map(where);
        var warnings = semantic.filter(function (d) {
            // Without the declarations every control name reads as undefined — noise, not a warning.
            return typesOk || !/^Cannot find name /.test(messageOf(d));
        }).map(where);
        var out = await client.getEmitOutput(uri.toString());
        var js = out.outputFiles && out.outputFiles[0] ? out.outputFiles[0].text : '';
        lastEmit = { code: code, js: js };
        return { js: js, errors: errors, warnings: warnings };
    }

    /// The module for this exact source — from the last run when it is the same code, otherwise
    /// transpiled now. Sharing sends it so the player never needs a compiler.
    window.fiddleReactEmit = async function (code) {
        if (lastEmit.code === code) return lastEmit.js;
        try { return (await transpile(code)).js; } catch (e) { return null; }
    };

    // Every control and every engine type by its own name, exactly as the skill spells them, plus
    // the hooks. A snippet writes <SkiaLabel …/> and useState() with nothing to import.
    function scopeOf(ns) {
        return Object.keys(ns).filter(function (k) { return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k); });
    }

    // The emitted module is imported for real, from a blob URL, so a snippet gets true module
    // semantics: its own scope, `export default`, top-level await. The preamble is what puts the
    // control names and the hooks in scope without an import line.
    async function evaluate(js) {
        var hooks = ['useState', 'useEffect', 'useMemo', 'useCallback', 'useRef', 'useReducer', 'useContext'];
        var preamble = 'const {' + scopeOf(window.DrawnUi).join(',') + '} = window.DrawnUi;\n'
            + 'const {' + hooks.join(',') + '} = window.React;\n'
            + 'const React = window.React;\n'
            // Names that are both a JSX tag and an engine class resolve to the tag above; Core is
            // how a snippet reaches the class, e.g. `new Core.SkiaLabel()` inside a recycled cell.
            + 'const Core = window.DrawnUiCore;\n'
            + 'const console = window.__fiddleReactConsole;\n';
        var url = URL.createObjectURL(new Blob([preamble + js], { type: 'text/javascript' }));
        try {
            return (await import(url)).default;
        } finally {
            URL.revokeObjectURL(url);
        }
    }

    // Console.WriteLine has an obvious twin here; the lines land in the same panel.
    function consoleProxy() {
        var write = function (kind) {
            return function () {
                var line = Array.prototype.map.call(arguments, function (a) {
                    if (typeof a === 'string') return a;
                    try { return JSON.stringify(a); } catch (e) { return String(a); }
                }).join(' ');
                logs.push(line);
                if (window.fiddleReactOnConsole) window.fiddleReactOnConsole(line);
                window.console[kind](line);
            };
        };
        return { log: write('log'), info: write('info'), warn: write('warn'), error: write('error') };
    }

    // The fiddle owns the Canvas, the snippet owns what is inside it — the same split as the C#
    // side, where the page owns the Canvas and the snippet returns a SkiaControl.
    function mount(host, content, bg) {
        var React = window.React, D = window.DrawnUi;
        // Leaving the editor for the feed and opening another fiddle unmounts the page and mounts
        // a NEW one, so this pane is a different element than the one the root was created for -
        // and a root keeps rendering into the node it was given, which is now detached. The
        // snippet compiled, the status said so, and the canvas stayed empty. Rebuild the root
        // whenever the pane it owns is not the pane on screen.
        if (root && (rootHost !== host || !host.isConnected)) {
            try { root.unmount(); } catch (e) { }
            root = null; view = null;
        }
        if (!root) { root = D.createRoot(host); rootHost = host; }
        root.render(React.createElement(D.Canvas, {
            ref: function (v) { view = v; },
            BackgroundColor: bg || '#000000',
            Gestures: 'Enabled',
            style: { width: '100%', height: '100%' },
        }, content));
    }

    /// Compile and render one TSX snippet. Returns the Roslyn-shaped result the page already knows.
    window.fiddleReactRun = async function (code, bg) {
        logs = [];
        try {
            var host = document.querySelector('[data-testid="fiddle-canvas-react"]');
            if (!host) return { success: false, errors: ['the React canvas pane is missing'], console: [] };

            var t = await transpile(code);
            if (t.errors.length) return { success: false, errors: t.errors, console: logs };
            // Type complaints are worth saying out loud without stopping the run. Through the same
            // channel as console.log, so they reach the panel rather than the returned array only.
            (t.warnings || []).forEach(function (w) {
                logs.push('type: ' + w);
                if (window.fiddleReactOnConsole) window.fiddleReactOnConsole('type: ' + w);
            });

            await boot();
            window.__fiddleReactConsole = consoleProxy();
            var exported = await evaluate(t.js);
            if (exported === undefined || exported === null)
                return { success: false, errors: ['the snippet exported nothing — end it with `export default App;`'], console: logs };

            // A component or a ready-made element: both are natural things to export.
            var content = typeof exported === 'function' ? window.React.createElement(exported) : exported;
            mount(host, content, bg);
            return { success: true, errors: [], console: logs };
        } catch (e) {
            return { success: false, errors: [(e && e.message) || String(e)], console: logs };
        }
    };

    /// Play a shared React snippet with no editor and no .NET at all: the module was transpiled
    /// when the snippet was shared, so the player only needs the engine and the module. That is
    /// ~4 MB instead of the ~20 MB .NET + Roslyn payload a C# player pulls.
    window.fiddleReactPlay = async function (id) {
        var app = document.getElementById('app');
        var base = window.fiddleApiBase || location.origin;
        try {
            var res = await fetch(base + '/api/share/' + encodeURIComponent(id) + '?js=1');
            if (!res.ok) {
                // Shared before the module was stored (or it expired): the editor still has a
                // compiler, so send them there rather than showing a dead canvas.
                location.replace(new URL('app#id=' + id, document.baseURI).href);
                return;
            }
            var js = await res.text();
            var bg = res.headers.get('X-Fiddle-Bg') || '#000000';
            document.documentElement.style.background = bg;

            app.innerHTML = '<div id="fx-react-player" style="position:fixed;inset:0"></div>';
            await boot();
            window.__fiddleReactConsole = consoleProxy();
            var exported = await evaluate(js);
            var content = typeof exported === 'function' ? window.React.createElement(exported) : exported;
            mount(document.getElementById('fx-react-player'), content, bg);
            document.documentElement.classList.remove('fx-booting');

            var badge = document.createElement('a');
            badge.className = 'fiddle-player-badge';
            badge.href = new URL('f/' + id, document.baseURI).href;
            badge.target = '_blank';
            badge.textContent = '⚡ Made with DrawnUI Fiddle';
            document.body.appendChild(badge);
        } catch (e) {
            app.innerHTML = '<div class="fiddle-player-error">This fiddle failed to run: '
                + ((e && e.message) || e) + '</div>';
            document.documentElement.classList.remove('fx-booting');
        }
    };

    /// The poster for a share: the CanvasKit surface itself, letterboxed onto the same 1200x630
    /// JPEG the C# side produces. The canvas element cannot be read directly — WebGL without
    /// preserveDrawingBuffer hands back a blank image (measured: 0 non-black pixels) — but the
    /// Skia surface behind it still holds the frame.
    window.fiddleReactThumb = async function (bg) {
        try {
            // The engine draws the picture again into an offscreen raster surface: the live one is
            // a WebGL drawing buffer the browser clears after compositing, so reading it back —
            // toDataURL or a snapshot — returns a blank image (measured: 0 lit pixels).
            var bytes = view && view.TakeScreenShot ? view.TakeScreenShot() : null;
            if (!bytes || !bytes.length) return null;

            var bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            var W = 1200, H = 630;
            var out = document.createElement('canvas');
            out.width = W; out.height = H;
            var g = out.getContext('2d');
            g.fillStyle = bg || '#000000';
            g.fillRect(0, 0, W, H);
            // Cover, centred — the same framing rule as the C# capture, so cards match.
            var scale = Math.max(W / bitmap.width, H / bitmap.height);
            var w = bitmap.width * scale, h = bitmap.height * scale;
            g.drawImage(bitmap, (W - w) / 2, (H - h) / 2, w, h);
            bitmap.close();
            var url = out.toDataURL('image/jpeg', 0.9);
            var b64 = url.slice(url.indexOf(',') + 1);
            return b64.length * 0.75 > 380 * 1024 ? null : b64;   // the worker's cap
        } catch (e) {
            return null;
        }
    };

    /// The canvas as a picture at its own pixel size — Export as PNG/JPEG. Same source as the
    /// poster, without the 1200x630 letterbox.
    window.fiddleReactFrame = async function (png) {
        try {
            var bytes = view && view.TakeScreenShot ? view.TakeScreenShot() : null;
            if (!bytes || !bytes.length) return null;
            if (png) {
                // TakeScreenShot already encodes PNG; nothing to re-encode.
                var bin = '';
                for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
                return btoa(bin);
            }
            var bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
            var out = document.createElement('canvas');
            out.width = bitmap.width; out.height = bitmap.height;
            out.getContext('2d').drawImage(bitmap, 0, 0);
            bitmap.close();
            var url = out.toDataURL('image/jpeg', 0.95);
            return url.slice(url.indexOf(',') + 1);
        } catch (e) {
            return null;
        }
    };

    /// Live console lines — the ones a tap handler or an effect prints AFTER the run — go to the
    /// page, so the panel behaves the same for both languages.
    window.fiddleReactHookConsole = function (dotnet) {
        window.fiddleReactOnConsole = function (line) {
            try { dotnet.invokeMethodAsync('ReactConsole', line); } catch (e) { }
        };
    };

    /// Switch the editor between the two languages. Done here rather than through the Blazor
    /// Monaco wrapper so the transpiler's own scratch model is never the one retagged.
    // The one model the editor uses once a language switch has happened (see below).
    var tsxModel = null;

    window.fiddleSetEditorLanguage = function (language) {
        // Configure BEFORE anything becomes TypeScript: setting the options respawns the worker,
        // and doing that afterwards would throw it away and fetch the 5.6 MB again.
        if (language === 'typescript') tsDefaults();
        var monaco = window.monaco;
        var editor = monaco.editor.getEditors ? monaco.editor.getEditors()[0] : null;
        if (!editor) return;
        var current = editor.getModel();

        // ONE model for both languages, living at a .tsx URI. The extension is what decides whether
        // the TypeScript service reads angle brackets as JSX or as a type assertion — tagged only
        // by language id, every tag read as "SkiaLabel refers to a value but is being used as a
        // type here" and nothing completed. Swapping between two models instead was worse: putting
        // Blazor's original model back tore the editor out of the page.
        if (!tsxModel) {
            tsxModel = monaco.editor.createModel(current.getValue(), current.getLanguageId(), monaco.Uri.parse('inmemory://fiddle/editor.tsx'));
            editor.setModel(tsxModel);
        }
        monaco.editor.setModelLanguage(tsxModel, language);
    };

    /// Drop what is on the React canvas — used when the editor switches back to C#.
    window.fiddleReactClear = function () {
        if (root) { root.render(null); }
    };
})();
