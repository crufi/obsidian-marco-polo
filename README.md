# Marco Polo

<!-- comment: obsidian plugin - it finds a path -->

Type a filesystem path inside backticks. Marco Polo validates it live, autocompletes
as it is typed, and turns valid paths into clickable links that reveal or open them in
the file manager.

Desktop only — it uses Node's `fs`/`os` and Electron's `shell`, which do not exist on
mobile. That is why `manifest.json` sets `isDesktopOnly: true`. Nothing is macOS-specific:
the defaults work on macOS, Windows, and Linux, and the open/reveal commands can be
overridden with anything.

## What it does

- Resolves `~`, `$VAR`, and `${VAR}` (see the security and environment notes below).
- Validates while typing, with a deliberately conservative colouring rule (next section).
- Configurable colour for valid paths, with a reset to the theme green.
- Autocomplete dropdown (Obsidian's `EditorSuggest`): up/down to browse, Enter/Tab to
  accept, Esc to dismiss. Directories sort first and get a trailing slash so completion
  continues into them.
- Click to act: in the editor, Cmd/Ctrl-click (configurable); in Reading mode a plain
  click always follows the link. Directories open in the file manager; files are revealed
  or opened per settings.
- Per-link override: append `#open` or `#reveal` inside the backticks to override the
  default file action for one link, e.g. `` `~/notes/today.md#open` ``. While the keyword
  is being typed it shows red; once it is a complete keyword it renders muted and is
  ignored for validation.

## The colouring rule

A span is decorated only when it has a valid *anchor*, so ordinary inline code never
lights up red by accident:

- With no internal `/`, the whole string must itself be a valid prefix. Typing toward
  `/foo`: `/` is green, `/f` stays green while something in `/` starts with `f`, `/fq`
  loses its colour and popup the moment nothing matches, and deleting back to `/f`
  restores it. Raw `/` (the root) is the trivial valid case.
- With an internal `/`, everything up to that first internal slash must be a real path.
  Once that anchor exists, the deepest existing prefix is green and the first
  committed-but-wrong component onward is red — so `/foo/anything` shows `/foo` green and
  `/anything` red.

The difference between the two: before the first internal slash there is no anchor yet,
so a wrong guess simply isn't treated as a path (no red). After a valid anchor, a wrong
component is shown red because the string is clearly a path attempt. A string whose anchor
does not exist (`/nope/x`, a regex, a comment) is left as plain code.

## Security

The expansion of `~` and `$VAR` is done by pure string substitution in JavaScript against
the process environment. A shell is never invoked on the path, so user text can never be
executed. This matters because the conventional way to expand variables — handing the text
to a shell — turns any span into a command-injection hole (for example zsh's `${(e)...}`
performs command substitution, so `$(rm -rf ~)` would run). Marco Polo avoids that category
of bug entirely by not letting span text enter a shell-evaluation context.

Defenses, in order:

1. Shape gate — only strings starting with `~`, `$`, or `/` are considered at all.
2. Pure-JS expansion — only `$VAR`, `${VAR}`, and a leading `~`/`~/` are substituted, from
   an environment map. No `eval`, no shell, no command substitution is possible.
3. Existence gate — the result must resolve to a real file or directory (`fs.stat`) before
   anything is clickable. Non-existent paths do nothing.
4. Safe invocation — the default open/reveal uses Electron's `shell` API, which takes a
   path argument directly and does not parse a command line.

The one place a shell is involved is the optional custom open/reveal command, which is
text *you* write in settings. There the `{path}` token is single-quote escaped before
substitution, and it is only ever filled with a path that already passed the existence
gate. Only put commands you trust in those fields.

### Why `~otheruser` is not supported

Only `~` and `~/...` (the current user, via `os.homedir()`) expand. `~otheruser` is left
untouched, so it fails the existence gate and never resolves. Resolving another account's
home would mean querying the system password database for an arbitrary username — extra
lookup surface for almost no benefit on a personal machine — so it is deliberately omitted.
Likewise an unknown `$VAR` is left as written rather than collapsing to empty, so `$NOPE/x`
never silently becomes `/x`.

## Environment variables (and the `$SHARE` caveat)

A GUI app inherits the login environment, not an interactive shell's exported variables, so
a `$FOO` defined only in `.zshrc` may be absent from `process.env` and therefore won't
resolve. `~`, `$HOME`, and other login-level variables are fine. (A future option may
source the login shell's environment once at startup to close this gap.)

## Install for local development

```sh
# comment: build, then symlink into the vault's plugin folder
npm install
npm run build            # one-off production build -> main.js
# or: npm run dev        # watch mode

# link the folder into a vault (adjust the vault path)
ln -s "$PWD" "/path/to/Vault/.obsidian/plugins/marco-polo"
```

Then enable Marco Polo under Settings -> Community plugins. Reload Obsidian (or use the
Hot-Reload plugin) after each build.

## Settings

- Valid path colour, with reset to the theme default.
- File click action: reveal in the file manager, or open with the default app.
- Require Cmd/Ctrl-click in the editor (Reading mode always follows a plain click).
- Custom open-directory command — blank uses the cross-platform default; override with
  e.g. macOS `open -a "Path Finder" {path}`, Linux `xdg-open {path}`, Windows
  `explorer {path}`.
- Custom reveal-file command — blank uses the cross-platform default.

## Layout

- `main.ts` — plugin entry: suggest, validation, click handling, settings.
- `pathutil.ts` — secure expansion, valid-prefix analysis, completion, command runner.
- `esbuild.config.mjs` — bundles `main.ts` -> `main.js`.
