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

function existsExpanded(rawPrefix: string): boolean {
	try {
		fs.statSync(expandPath(rawPrefix));
		return true;
	} catch {
		return false;
	}
}

export function classifyPath(raw: string): PathKind {
	try {
		return fs.statSync(expandPath(raw)).isDirectory() ? "dir" : "file";
	} catch {
		return "missing";
	}
}

// candidates must start with ~, $ or / — anything else (regex, code, prose) is
// left alone. Relative "./" and "../" are intentionally excluded: there is no
// reliable base directory to resolve them against inside Obsidian.
export function looksLikePath(raw: string): boolean {
	const p = raw.trim();
	return p.length > 0 && /^(~|\$|\/)/.test(p);
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
// For "~" and "$VAR" (no slash) the test is simply existence.
function shouldDecorate(path: string, existEnd: number): boolean {
	if (path === "/") return false;
	const firstSep = path.indexOf("/");
	if (firstSep < 0) return existEnd === path.length; // ~, $VAR
	const secondSep = path.indexOf("/", firstSep + 1);
	if (secondSep < 0) return existEnd === path.length; // one separator: must be valid
	const afterSecond = path.slice(secondSep + 1);
	if (afterSecond === "") return existEnd === path.length; // "/x/": conservative
	return existEnd > 0; // content past 2nd separator: first component must exist
}

// Analyze an inline-code span: whether to decorate, and where the green/red
// boundary sits (the deepest prefix that actually exists). A still-incomplete
// final component is NOT specially greened — green covers only what exists.
export function analyzeSpec(inner: string): Spec {
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
		if (candidate.length > 0 && existsExpanded(candidate) && !existsExpanded(inner)) {
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

	// deepest prefix that actually exists, walking "/" boundaries (monotonic).
	const bounds: number[] = [];
	for (let i = 1; i < path.length; i++) if (path[i] === "/") bounds.push(i);
	bounds.push(path.length);
	let existEnd = 0;
	for (const b of bounds) {
		const pre = path.slice(0, b);
		if (pre === "") continue;
		if (existsExpanded(pre)) existEnd = b;
		else break;
	}

	const decorate = shouldDecorate(path, existEnd);
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
export function completePath(partial: string): string[] {
	const expanded = expandPath(partial.replace(FRAGMENT_RE, ""));
	const sep = expanded.lastIndexOf("/");
	if (sep < 0) return [];
	const dir = sep === 0 ? "/" : expanded.slice(0, sep);
	const base = expanded.slice(sep + 1).toLowerCase();
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const dirWithSlash = dir.endsWith("/") ? dir : dir + "/";
	return entries
		.filter((e) => e.name.toLowerCase().startsWith(base))
		.filter((e) => base.length > 0 || !e.name.startsWith(".")) // hide dotfiles until typed
		.sort((a, b) => {
			const ad = a.isDirectory() ? 0 : 1;
			const bd = b.isDirectory() ? 0 : 1;
			return ad - bd || a.name.localeCompare(b.name);
		})
		.slice(0, 50)
		.map((e) => dirWithSlash + e.name + (e.isDirectory() ? "/" : ""));
}
