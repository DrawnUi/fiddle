---
name: drawnui-fiddle
description: Drive DrawnUI Fiddle (in-browser C# → Roslyn WASM → live Skia canvas) as an AI agent via window.fiddle JS API + Playwright. Use for testing DrawnUI snippets in the fiddle, validating fiddle features, reproducing DrawnUI rendering in browser, or automating https://fiddle.drawnui.net. Trigger on "fiddle", "drawnui fiddle", "test snippet in fiddle", "fiddle.drawnui.net".
---

# DrawnUI Fiddle — AI automation

In-browser C# editor (Monaco) compiled with Roslyn on WASM, rendered live on a DrawnUI Skia canvas. Zero server.

- Live: `https://fiddle.drawnui.net/`
- This skill online: `https://fiddle.drawnui.net/skills/drawnui-fiddle/SKILL.md` (install: save under `~/.claude/skills/drawnui-fiddle/SKILL.md`)
- Companion skills for writing snippet code: `https://drawnui.net/skills/drawnui-fluent/SKILL.md` (fluent C# composition — the style snippets should use), `https://drawnui.net/skills/drawnui/SKILL.md` (framework deep guidance)

## Golden flow (Playwright or any browser automation)

1. Navigate to the fiddle URL.
2. Wait for boot (WASM + ~60 assembly refs, cold start 10–20s): poll `evaluate` until `window.fiddle && (await fiddle.getState()).ready === true`.
3. `await fiddle.setCode(code)` — NEVER type code into Monaco with keystrokes.
4. `const r = await fiddle.run()` → `{ success, errors, status }`.
5. `r.success === false` → fix code from `r.errors` (format `"L16: message"`, line numbers match editor lines), retry.
6. `await fiddle.getConsole()` → `Console.WriteLine` lines from the snippet (console-first evidence).
7. Pixels only when needed: compositor **element** screenshot of `[data-testid="fiddle-canvas"]` (e.g. Playwright element screenshot).

## window.fiddle API (all async)

```js
await fiddle.getState()        // { ready, running, status, errors }
await fiddle.getCode()         // current editor code
await fiddle.setCode(code)     // replace editor code
await fiddle.run()             // { success, errors, status } — compiles + renders
await fiddle.getConsole()      // string[] Console.WriteLine output
await fiddle.listPresets()     // [{ slug, name }] — built-ins (welcome, ui, effect, cells, kids, looks, spinner, editor, dataio, weather, glass, custom, sksl, paint); don't hardcode the list or the count, query it
await fiddle.loadPreset(slug)  // true/false — loads + runs
```

Backed by Blazor `[JSInvokable]` methods on FiddlePage (`Api*`), registered via `registerFiddleApi` in `wwwroot/fiddle-intellisense.js`.

## Snippet contract

Code = **method body** of `static SkiaControl Build()` — must `return` a `SkiaControl`. Wrapper (in `RoslynCompiler.cs`) already provides usings: `System`, `System.Linq`, `System.Collections.Generic`, `DrawnUi`, `DrawnUi.Draw`, `DrawnUi.Views`, `DrawnUi.Controls`, `AppoMobi.Gestures`, `AppoMobi.Specials`, `SkiaSharp`. No class/namespace declarations — can declare local vars, local functions, lambdas before the `return`.

Resources panel files (seeded: `dotnetbotcar.png`, `iosloader.json`, `texture.jpg`, `cam.jpg`, `drawnui.svg`) are addressable by bare file name in code (e.g. `Source = "drawnui.svg"`).

## Numbers in strings: use invariant culture

Snippets run in the browser, so `CultureInfo.CurrentCulture` is the visitor's locale: `$"{51.5}"` can
emit `51,5` and silently break a URL, a JSON body or any protocol string (a real bug: an API answered
`HTTP 400` only for users with a comma locale). Whenever a number goes into a URL/JSON/protocol, use
`FormattableString.Invariant($"...")` or `value.ToString(CultureInfo.InvariantCulture)`. Display text is fine as-is.

## Data in / events out (`Fiddle` API for snippets)

```csharp
var city  = Fiddle.Query.Text("city", "Belgrade");   // per-viewer URL values: ?city=London
var count = Fiddle.Query.Int("count", 3);            // also Double / Bool / Csv / List
Fiddle.Load(url, json => { /* JsonElement */ }, err => { /* string */ });  // host fetches JSON for the app
Fiddle.Emit("buy", "{\"plan\":\"gold\"}");           // event out to the embedding page / console
Fiddle.Open("https://example.com/checkout");         // ask the host to open a URL
var mode = Fiddle.Mode;                              // "editor" | "player" | "server"
```

- `Fiddle.Query` reads the page URL; in the editor the params box next to Run supplies the same values
  (`city=London&count=3`), so a snippet can be tested with different inputs without publishing.
- `Fiddle.Load` is the only way to reach the network from a snippet: `https` only, one JSON document per
  call, capped and cached briefly. The callback runs after the fetch — update controls there and call
  `Update()`. Chain calls (geocode → forecast) by starting the second `Load` inside the first callback.
- `Fiddle.Emit` reaches an embedding page as `postMessage` (`{fiddle:"buy", …}`) and shows in the console;
  `Fiddle.Open` is the sandbox-safe navigation request.
- Full guide with runnable examples: `https://fiddle.drawnui.net/docs/#dataio`; presets `dataio` and
  `weather` (`/app/dataio`, `/app/weather`) are the reference snippets.

## Screenshot rule (VERIFIED 2026-07-15)

- `canvas.toDataURL()` = **always blank**: canvas is webgl2 with `preserveDrawingBuffer:false` + on-demand rendering. rAF-timed capture also blank. Do not attempt.
- Compositor screenshot (Playwright `browser_take_screenshot` with `target: '[data-testid="fiddle-canvas"]'`) **works** — returns exact rendered pixels.

## DOM anchors (data-testid)

| testid / id | element |
|---|---|
| `fiddle-presets` | preset buttons container |
| `fiddle-run` | ▶ Run button |
| `fiddle-status` | status text ("✓ Compiled and rendered" / "✗ N error(s)") |
| `fiddle-errors` | error panel (only rendered when errors exist) |
| `fiddle-canvas` | canvas pane — screenshot target |
| `#fiddle-console-body` | console output panel |
| `#fiddle-editor` | Monaco editor host |

## Gotchas

- `fiddle` object appears only after Monaco init; `ready:true` only after Roslyn refs loaded. Always gate on `getState().ready`.
- `setCode` triggers HotReload autocompile too (debounced); explicit `run()` after it is still correct — duplicate builds are deduped by unchanged-code check.
- `run()` waits out any in-flight build, so its result reflects your code.
- Host requirement for the RCL: `WasmEnableWebcil=false` (Roslyn fetches plain-PE DLLs from `_framework`).
- Share links: code deflate-packed in `#code=` hash (`fiddleShareEncode`), opens in single-fiddle mode.
