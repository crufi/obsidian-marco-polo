// comment: secure path expansion, structural decoration rule, completion, open/reveal
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";

export type Action = "open" | "reveal";
export type PathKind = "dir" | "file" | "missing";
export type FragmentState = "none" | "valid" | "pending";

// optional trailing action hint, possibly mid-typed: `/path#open`, `/path#rev`
const FRAGMENT_RE = /#([A-Za-z]*)\s*$/;

export interface Spec {
	decorate: boolean; // false => render nothing; the span looks like plain code
	path: string; // inner string minus any "#action" fragment
	greenEnd: number; // color [0, greenEnd) green (the deepest existing prefix)
	existEnd: number; // length of the deepest existing prefix (== greenEnd; click target)
	fragment: string; // trailing "#..." text, or ""
	fragmentState: FragmentState; // complete keyword, mid-typing, or absent
	action: Action | null; // per-link override, set only once the fragment is valid
}

// The environment used for $VAR expansion. Defaults to the process environment;
// the plugin may replace it with a richer map sourced from the login shell (so
// exported variables like $SHARE resolve). This is data only — see setEnvMap.
let envMap: Record<string, string | undefined> = process.env;
export function setEnvMap(map: Record<string, string | undefined>): void {
	envMap = map;
}

// ---- existence cache -------------------------------------------------------
// fs.statSync is slow on network mounts (a likely home for $SHARE), and the
// editor re-validates on every keystroke, so the render path must never block.
// cachedKind() answers from memory; on a miss (or a stale entry) it schedules a
// background fs.stat, and when that resolves to a *different* answer it notifies
// listeners so the affected views re-decorate. classifyPath() and the
// reading-mode render keep a synchronous check on purpose: a one-shot render and
// an explicit click can afford a brief wait and want a definitive answer.
const statCache = new Map<string, { kind: PathKind; t: number }>();
const pendingStats = new Set<string>();
type StatListener = () => void;
const statListeners = new Set<StatListener>();

// register a callback fired whenever a background stat changes a cached answer;
// returns an unsubscribe function. The editor uses this to repaint.
export function onStatResolved(fn: StatListener): () => void {
	statListeners.add(fn);
	return () => statListeners.delete(fn);
}
export function clearStatCache(): void {
	statCache.clear();
}

function scheduleStat(expanded: string): void {
	if (pendingStats.has(expanded)) return;
	pendingStats.add(expanded);
	fs.stat(expanded, (err, st) => {
		pendingStats.delete(expanded);
		const kind: PathKind = err || !st ? "missing" : st.isDirectory() ? "dir" : "file";
		const prev = statCache.get(expanded);
		statCache.set(expanded, { kind, t: Date.now() });
		if (!prev || prev.kind !== kind) for (const fn of statListeners) fn();
	});
}

// cached, non-blocking kind. Unknown -> undefined plus a background stat; a
// >5s-old entry returns its last value but refreshes in the background, so the
// editor never flickers while still catching filesystem changes within ~5s.
function cachedKind(expanded: string): PathKind | undefined {
	const e = statCache.get(expanded);
	if (!e) {
		scheduleStat(expanded);
		return undefined;
	}
	if (Date.now() - e.t > 5000) scheduleStat(expanded);
	return e.kind;
}

// synchronous kind, for the one-shot reading-mode render and explicit clicks.
// Also populates the cache so the editor benefits from the result.
function syncKind(expanded: string): PathKind {
	let kind: PathKind;
	try {
		kind = fs.statSync(expanded).isDirectory() ? "dir" : "file";
	} catch {
		kind = "missing";
	}
	statCache.set(expanded, { kind, t: Date.now() });
	return kind;
}

// Expand a leading ~ and $VAR / ${VAR}. Pure string substitution against envMap —
// no shell is ever invoked on the path, so user text can never be executed (see
// SECURITY in the README). Two deliberate limits:
//   * only "~" or "~/..." (the current user). "~otheruser" is left untouched, so
//     it fails the existence check and is never expanded — we do not consult the
//     password database to resolve another account's home.
//   * an unknown variable is left as written, so it likewise fails to resolve
//     rather than silently collapsing (e.g. "$NOPE/x" never becomes "/x").
export function expandPath(raw: string): string {
	let p = raw.trim();
	if (p === "~" || p.startsWith("~/")) {
		p = os.homedir() + p.slice(1);
	}
	p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => envMap[name] ?? m);
	p = p.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => envMap[name] ?? m);
	return p;
}

// `sync` true -> blocking check (reading mode, clicks); false -> cached,
// non-blocking check (the editor render path).
function existsExpanded(rawPrefix: string, sync: boolean): boolean {
	const expanded = expandPath(rawPrefix);
	const kind = sync ? syncKind(expanded) : cachedKind(expanded);
	return kind !== undefined && kind !== "missing";
}

export function classifyPath(raw: string): PathKind {
	return syncKind(expandPath(raw));
}

// candidates must start with ~, $ or / — anything else (regex, code, prose) is
// left alone. Relative "./" and "../" are intentionally excluded: there is no
// reliable base directory to resolve them against inside Obsidian.
export function looksLikePath(raw: string): boolean {
	const p = raw.trim();
	// leading ~, $VAR, POSIX "/…", a Windows drive ("C:\" or "C:/"), or a UNC
	// share ("\\server"). Relative "./" and "../" are still excluded.
	return p.length > 0 && /^(~|\$|\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

// Decide whether a path-like span is unambiguous enough to decorate at all.
// `existEnd` is the length of the deepest prefix that exists (so existEnd > 0
// means the first component resolves, and existEnd === path.length means the
// whole thing exists). The rule, in the user's words:
//   * "/" alone               -> not decorated
//   * "/valid-prefix"         -> decorate iff it exists (single component)
//   * "/bad-prefix" (1 slash) -> not decorated
//   * "/valid-prefix/"        -> decorate iff it exists (could be a regex)
//   * "/x/y..." (text after a second separator) -> decorate iff the first
//     component exists, so genuine paths light up but regexes and
//     nonexistent-root strings stay plain.
// For "~" and "$VAR" (no slash) the test is simply existence. `npath` is the
// separator-normalized path (Windows "\" already mapped to "/"); indices match
// the original path 1:1 because the swap is length-preserving.
function shouldDecorate(npath: string, existEnd: number): boolean {
	if (npath === "/") return false;
	const firstSep = npath.indexOf("/");
	if (firstSep < 0) return existEnd === npath.length; // ~, $VAR
	const secondSep = npath.indexOf("/", firstSep + 1);
	if (secondSep < 0) return existEnd === npath.length; // one separator: must be valid
	const afterSecond = npath.slice(secondSep + 1);
	if (afterSecond === "") return existEnd === npath.length; // "/x/": conservative
	return existEnd > 0; // content past 2nd separator: first component must exist
}

// A "~" or "$VAR" that resolves to an absolute path only makes sense as the very
// first segment. Embedded absolute expansions ("/$SHARE", "/a/$SHARE") collapse
// to something the OS may still stat, but that is not what was typed — treat them
// as not-a-path so they stay plain rather than lighting up green. ("~" is only
// ever expanded at the start, so only $VAR needs checking here.)
function hasEmbeddedAbsoluteVar(path: string): boolean {
	const re = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(path)) !== null) {
		if (m.index === 0) continue; // a variable at the very start is fine
		const val = envMap[m[1]];
		if (val && val.startsWith("/")) return true;
	}
	return false;
}

// A spec is ill-formed when it has an empty path component ("//" — e.g. a
// literal "//Users/…", or "/$SHARE" where $SHARE is absolute), or when a $VAR
// resolving to an absolute path is embedded after the first segment. Such specs
// may still stat (the OS collapses "//"), but they are not what was typed, so
// neither validation nor completion should treat them as paths. A genuine
// leading-"//" UNC root is allowed only on Windows.
function isMalformedPath(path: string): boolean {
	const npath = path.replace(/\\/g, "/");
	const dbl = npath.indexOf("//");
	if (dbl >= 0) {
		const uncRoot = dbl === 0 && process.platform === "win32";
		if (!uncRoot || npath.indexOf("//", 2) >= 0) return true;
	}
	return hasEmbeddedAbsoluteVar(path);
}

// Analyze an inline-code span: whether to decorate, and where the green/red
// boundary sits (the deepest prefix that actually exists). A still-incomplete
// final component is NOT specially greened — green covers only what exists.
// `sync` selects the blocking existence check (reading mode, where the render is
// one-shot) over the cached non-blocking one (the editor, the default).
export function analyzeSpec(inner: string, sync = false): Spec {
	let path = inner;
	let fragment = "";
	let fragmentState: FragmentState = "none";
	let action: Action | null = null;

	// Peel a trailing "#word" (word may be empty/partial) only when the path
	// before "#" exists and the whole string does not — so a real path containing
	// "#" is left intact while an action fragment being typed is recognized.
	const fm = inner.match(FRAGMENT_RE);
	if (fm && fm.index !== undefined) {
		const candidate = inner.slice(0, fm.index);
		if (candidate.length > 0 && existsExpanded(candidate, sync) && !existsExpanded(inner, sync)) {
			path = candidate;
			fragment = inner.slice(fm.index);
			const word = fm[1].toLowerCase();
			if (word === "open" || word === "reveal") {
				action = word as Action;
				fragmentState = "valid";
			} else {
				fragmentState = "pending"; // empty or partial keyword -> shown red
			}
		}
	}

	// Normalize Windows "\" to "/" only to locate separators; indices line up 1:1
	// with `path` (length-preserving), so slices below use the original text.
	const npath = path.replace(/\\/g, "/");

	// deepest prefix that actually exists, walking separators (monotonic).
	const bounds: number[] = [];
	for (let i = 1; i < npath.length; i++) if (npath[i] === "/") bounds.push(i);
	bounds.push(npath.length);
	let existEnd = 0;
	for (const b of bounds) {
		const pre = path.slice(0, b);
		if (pre === "") continue;
		if (existsExpanded(pre, sync)) existEnd = b;
		else break;
	}

	const decorate = !isMalformedPath(path) && shouldDecorate(npath, existEnd);
	return { decorate, path, greenEnd: existEnd, existEnd, fragment, fragmentState, action };
}

// single-quote escape for safe interpolation into a /bin/sh command. Only ever
// applied to a path that already passed the existence check.
function shQuote(p: string): string {
	return `'${p.replace(/'/g, `'\\''`)}'`;
}

export function runCommandTemplate(template: string, expandedPath: string): void {
	const cmd = template.replace(/\{path\}/g, shQuote(expandedPath));
	exec(cmd, (err) => {
		if (err) console.error("[marco-polo] command failed:", cmd, err);
	});
}

// directory listing for autocomplete. partial is the in-progress path.
// returns matching child entries with a trailing slash on directories.
//
// The literal prefix up to the last separator (e.g. "$SHARE/", "~/") is kept
// verbatim in the results; expansion happens only to read the directory. So
// accepting a completion preserves the variable and the inserted link stays
// portable — it resolves on demand at click time, not at completion time.
export function completePath(partial: string): string[] {
	const raw = partial.replace(FRAGMENT_RE, "");
	// split on the last separator in the ORIGINAL text ("\" treated as "/", which
	// is length-preserving so the index stays valid against `raw`).
	const sep = raw.replace(/\\/g, "/").lastIndexOf("/");
	if (sep < 0) return [];
	const prefix = raw.slice(0, sep + 1); // literal, includes the separator
	if (isMalformedPath(prefix)) return []; // no dropdown for "/$SHARE/", "//x/", …
	const base = raw.slice(sep + 1).toLowerCase();
	const dir = expandPath(prefix); // expand only to read the directory
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries
		.filter((e) => e.name.toLowerCase().startsWith(base))
		.filter((e) => base.length > 0 || !e.name.startsWith(".")) // hide dotfiles until typed
		.sort((a, b) => {
			const ad = a.isDirectory() ? 0 : 1;
			const bd = b.isDirectory() ? 0 : 1;
			return ad - bd || a.name.localeCompare(b.name);
		})
		.slice(0, 50)
		.map((e) => prefix + e.name + (e.isDirectory() ? "/" : ""));
}
