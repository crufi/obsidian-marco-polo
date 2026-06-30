<!-- comment: project context and handoff notes for claude code -->

# Marco Polo — project context

An Obsidian plugin. Type a filesystem path inside backticks (`` `~/notes` ``) and it
validates the path live, autocompletes it, colors it, and makes it clickable to reveal or
open in the file manager. Repo `obsidian-marco-polo`, plugin id `marco-polo`, product name
"Marco Polo", author `crufi`. Desktop only (`isDesktopOnly: true`) because it uses Node
`fs`/`os` and Electron `shell`.

Current state: v0.1.0, builds clean, `main.js` ~20 KB. Functionally complete for a first
release; remaining work is polish and the publishing path (see Next steps).

## Build and dev

- `npm install`
- `npm run build` — `tsc -noEmit -skipLibCheck` then esbuild production bundle to `main.js`
- `npm run dev` — esbuild watch
- `npm test` — unit tests for `pathutil.ts` via Node's built-in runner (`node --test`,
  Node strips the TS types; needs Node 23+). No test framework dependency.
- If `npm run build` fails with `spawn ENOEXEC`, `node_modules` was installed on a different
  OS/arch (esbuild ships a native binary). Fix: `rm -rf node_modules package-lock.json &&
  npm install` on this machine.
- Install into a vault: `ln -s "$PWD" ~/<vault>/.obsidian/plugins/marco-polo`, then enable
  under Settings -> Community plugins and reload. The dev vault in use is `~/codex`.

## File layout

- `main.ts` — plugin entry: the `EditorSuggest`, the CodeMirror 6 validation extension, the
  reading-mode post-processor, the click handler, the `insert-path` picker, shell-env
  sourcing, commands, and the settings tab.
- `pathutil.ts` — secure path expansion, the decoration analysis (`analyzeSpec`), the
  decoration rule (`shouldDecorate`), directory completion, and the custom-command runner.
- `test/pathutil.test.ts` — unit tests over the pure logic: the `expandPath` security
  property, the decoration rule against a real temp tree, completion, and the async cache.
- `styles.css` — green/red/fragment span styles, suggestion and picker styles.
- `esbuild.config.mjs` — bundles `main.ts`; externals are obsidian, electron, codemirror,
  and lezer packages.
- `manifest.json`, `versions.json`, `package.json`, `tsconfig.json`, `LICENSE` (MIT),
  `.gitignore` (ignores `node_modules/`, `main.js`, `data.json`).

## The decoration rule (important — settled after iteration)

`analyzeSpec(inner)` returns `{ decorate, path, greenEnd, existEnd, fragment,
fragmentState, action }`. `existEnd` is the length of the deepest prefix that actually
exists on disk; `greenEnd === existEnd` (green covers only what exists — there is no
prefix-match "green while typing" extension; that idea was tried and dropped). When
decorated, the existing prefix is green and the remainder is red.

`shouldDecorate(path, existEnd)` decides whether a span is unambiguous enough to decorate
at all, so ordinary inline code and regexes do not light up:

- `/` alone — not decorated.
- one component, no second slash (`/foo`) — decorate only if it exists.
- trailing slash (`/foo/`) — decorate only if it exists (could be a regex).
- content after a second separator (`/foo/bar`, `/a/b/c`) — decorate only if the first
  component exists (the "anchor variant", chosen deliberately). So genuine paths light up
  because their root almost always exists, while a regex like `/\d+/g` or a nonexistent
  root like `/bad/x` stays plain.
- `~` and `$VAR` with no slash — decorate only if they resolve.
- ill-formed specs are rejected by `isMalformedPath` (shared by validation and
  completion): an empty path component `//` — whether typed literally
  (`//Users/…`) or produced by an absolute `$VAR` after the first segment
  (`/$SHARE`, `/a/$SHARE`) — stays plain even though the OS would collapse and
  `stat` it. A genuine leading-`//` UNC root is allowed only on Windows. A `$VAR`
  with a *relative* value mid-path (e.g. `~/p/$PROJECT`) is still fine, and so is
  a `$VAR` whose value happens to end in a slash.

This rule is now pinned by `test/pathutil.test.ts` (the executable form of the old "verified
against a real `/tmp` tree" check); run `npm test` after changing it.

Existence checks are non-blocking on the editor render path. `analyzeSpec(inner, sync=false)`
reads from an in-memory cache (`cachedKind`); a miss returns "not yet known" and schedules a
background `fs.stat`, and `onStatResolved` listeners repaint when an answer changes — so a
slow/network mount (a likely `$SHARE` home) never janks typing. Reading mode passes
`sync=true` (a one-shot render can afford a blocking `fs.statSync`), and `classifyPath` (used
on an explicit click) stays synchronous on purpose. Stale entries (>5s) refresh in the
background without flicker. The editor CM6 plugin repaints via the `mpRerender` `StateEffect`
and no longer rebuilds on cursor moves (`selectionSet` dropped).

## Path expansion and security

Expansion is pure string substitution in JavaScript against an environment map — a shell is
never invoked on span text, so user text can never be executed. This is the core security
property; do not regress it. The conventional "expand via shell" approach (e.g. zsh
`${(e)...}`) performs command substitution and would let `$(rm -rf ~)` run.

Defenses: shape gate (`looksLikePath` requires a leading `~`, `$`, or `/`), pure-JS
expansion, an existence gate (`fs.stat`) before anything is clickable, and Electron `shell`
for the default open/reveal (takes a path argument, no command line parsing).

Two opt-in places touch a shell, neither with span text: the optional custom open/reveal
command (the `{path}` token is single-quote escaped and only filled with an existence-checked
path), and shell-env sourcing (runs `printenv` only, output parsed as inert `KEY=VALUE`).

Deliberate limits: `~otheruser` is left untouched (no password-database lookup), and an
unknown `$VAR` is left literal rather than collapsing to empty.

## Shell-env sourcing (resolving `$SHARE`)

A GUI app inherits the login environment, not an interactive shell's exports, so a variable
defined only in `.zshrc` is normally absent. When `sourceShellEnv` is on (default; skipped
on Windows), `loadShellEnv()` runs `$SHELL -ilc printenv` once at startup, parses the
exported variables, merges them over `process.env`, and hands the map to `setEnvMap`.
`-ilc` is interactive + login so `.zshrc` exports are captured. Only exported variables are
visible (`export SHARE=...`, not a bare `SHARE=...`). The command `Marco Polo: Refresh
environment variables` re-sources after dotfile edits; `specCache` is cleared on refresh.

Portability is the point of `$VAR` links: the path text is the source of truth and is never
rewritten with an expansion. `completePath` keeps the literal prefix (`$SHARE/`, `~/`) in its
suggestions — it expands only to read the directory — so accepting a completion preserves the
variable. Validation/coloring expands eagerly (green = currently resolves) but a click
re-expands on demand (`activatePath` -> `classifyPath`/`expandPath`), so changing `$SHARE`
keeps an existing link pointing at the new target.

## Other behaviors

- Action fragment: append `#open` or `#reveal` inside the backticks to override the file
  action for one link. While the keyword is partial it renders red (`mp-path-frag-pending`);
  once complete it renders muted (`mp-path-frag`) and is ignored for validation. The
  fragment is only recognized when the path before `#` exists and the whole string does not.
- Click: editor uses Cmd/Ctrl-click when `requireModifierClick` is on; reading mode always
  follows a plain click. Directories open; files reveal or open per `fileClickAction` or the
  per-link override.
- Cross-platform: defaults use Electron `shell.openPath` / `showItemInFolder`. Custom
  open/reveal commands are user-provided with a `{path}` token (examples for macOS, Linux,
  Windows in settings and README). Nothing is macOS-specific. Path *detection* also accepts
  Windows drive (`C:\`/`C:/`) and UNC (`\\server`) shapes; `\` is normalized to `/` only to
  locate separators (length-preserving, so display indices are unaffected). Windows support
  is best-effort and untested on a real Windows box; `$VAR` (not `%VAR%`) is the only
  variable form expanded.
- `insert-path` command: a drill-down `SuggestModal` seeded at `~/`. Enter a folder to
  descend (reopens seeded there); the accented "Insert …" row commits the current path as a
  backtick span at the cursor.
- The `EditorSuggest` popup carries a "Marco Polo" footer with key hints via
  `setInstructions`. Key semantics differ deliberately: Tab accepts and keeps the
  popup open (the inserted text — a directory keeps its trailing slash —
  re-triggers `onTrigger`, so completion drills onward), while Enter or a click
  accepts and dismisses. Dismiss is enforced with a one-shot `suppressReopen`
  flag that `onTrigger` consumes, since the inserted text would otherwise reopen
  the popup. Tab is wired on `this.scope` (Obsidian only binds Enter by default)
  via the internal `suggestions.useSelectedItem`.

## Settings (`MarcoPoloSettings`)

`fileClickAction` (reveal | open, default reveal), `openDirCommand` / `revealFileCommand`
(blank = Electron default), `requireModifierClick` (default true), `validColor` (hex color from the settings
color-picker, "" = theme green, applied via the `--mp-valid-color` variable; the variable
accepts any CSS color but the UI only yields hex), `sourceShellEnv` (default true).

## Known issues and gotchas

- Dangling symlink crash: if the plugin symlink points at a path that disappears, Obsidian
  fails to start with `ENOENT ... stat .../plugins/marco-polo`. This already happened once
  when the link pointed at a temporary scratch folder. Point the link at the persistent repo
  (`~/src/obsidian-marco-polo`) or copy the built files in.
- Click target for a mid-typed root-level partial (e.g. `/t`) is empty, because the root `/`
  is not a counted boundary, so `existEnd` is 0 and a click would no-op with a "not found"
  notice. Harmless in practice; could be fixed by treating the root as an existing boundary.
- Only exported shell variables are visible to `printenv` (noted above).

## Next steps (discussed, not yet built)

- Master toggle to disable ambient detection (explicit-insert-only mode). Would gate the
  `EditorSuggest`, the CM6 extension, and the reading-mode processor on a setting.
- Let the `insert-path` "Insert" row honor a default `#open` / `#reveal`.
- Optional inline ghost-text autocomplete as an alternative to the dropdown (deferred).
- "Survives move/rename" is not implemented; the path text is the source of truth. An inode
  hint could help recovery, but is out of scope for now.
- Publishing: `fs`/`child_process` use is allowed and only forces `isDesktopOnly`. Review
  scrutiny will focus on the shell-out paths, so keep the Electron `shell` default, keep the
  `shQuote` escaping, and never `eval` user strings. Name note: "Path Finder" is taken by an
  existing Obsidian plugin and a macOS app, so keep the name "Marco Polo".

## Repo / git note

Git history now has four commits; the structural decoration rule, anchor variant, shell-env
sourcing, footer label, and `insert-path` command are committed (`1373632`, `fc0e634`) — the
old "saved in the working tree but not committed" note is obsolete. `main.js`, `node_modules/`,
and `data.json` remain gitignored, so a community-plugin release attaches the built `main.js`,
`manifest.json`, and `styles.css` to a GitHub release rather than committing them.

Note: `node_modules` had been installed under Linux (cowork sandbox), so esbuild's native
binary failed with `spawn ENOEXEC` on this Mac until a native `npm install` (see Build and dev).

## Conventions

US spelling only (color, not colour). In docs, avoid second-person "you" where a neutral
phrasing reads as well. Keep caps and emphasis minimal. Source files start with a terse
`# comment:` (or `//` / `/* */`) line describing the file's purpose. Filenames use hyphens,
not underscores.
