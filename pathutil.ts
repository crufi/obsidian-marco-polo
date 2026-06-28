// comment: secure path expansion, valid-prefix analysis, completion, open/reveal
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
	greenEnd: number; // colour [0, greenEnd) green (existing prefix + matching partial)
	existEnd: number; // length of the deepest prefix that actually exists (click target)
	fragment: string; // trailing "#..." text, or ""
	fragmentState: FragmentState; // complete keyword, mid-typing, or absent
	action: Action | null; // per-link override, set only once the fragment is valid
}

// Expand a leading ~ and $VAR / ${VAR}. This is pure string substitution against
// the process environment — no shell is ever invoked, so user text can never be
// executed (see SECURITY in the README). Two deliberate limits:
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
	p = p.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => process.env[name] ?? m);
	p = p.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (m, name) => process.env[name] ?? m);
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

// True when the final, in-progress component of `rawPath` is a prefix of some
// real entry in its parent directory (the autocomplete sense of "still valid").
function lastComponentMatches(rawPath: string): boolean {
	const exp = expandPath(rawPath);
	const slash = exp.lastIndexOf("/");
	if (slash < 0) return false;
	const parent = slash === 0 ? "/" : exp.slice(0, slash);
	const base = exp.slice(slash + 1).toLowerCase();
	if (base === "") {
		try {
			return fs.statSync(parent).isDirectory();
		} catch {
			return false;
		}
	}
	let names: string[];
	try {
		names = fs.readdirSync(parent);
	} catch {
		return false;
	}
	return names.some((n) => n.toLowerCase().startsWith(base));
}

// Decide whether/how to decorate an inline-code span.
//
// A span is decorated only when it has a valid anchor:
//   * with no internal "/", the whole string must itself be a valid prefix
//     (it exists, or its last component matches something) — e.g. "/", "/fo";
//   * with an internal "/", everything up to that first internal slash must be a
//     real path — e.g. "/foo" in "/foo/bar".
// Without a valid anchor the span is left as plain code (no red), so ordinary
// text like "/nope/x" or a regex never lights up. With an anchor, the deepest
// existing prefix is green, a still-matching final component stays green, and
// the first committed-but-wrong component onward is red.
export function analyzeSpec(inner: string): Spec {
	let path = inner;
	let fragment = "";
	let fragmentState: FragmentState = "none";
	let action: Action | null = null;

	// Peel a trailing "#word" (word may be empty/partial) only when the path
	// before "#" exists and the whole string does not — so a real path containing
	// "#" is left intact while an action fragment being typed is recognised.
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

	// extend green over a final in-progress component that still prefix-matches,
	// but only if what remains is a single component (no deeper committed slash).
	let greenEnd = existEnd;
	if (existEnd < path.length) {
		const remainder = path.slice(existEnd); // begins with "/" (or is the whole)
		const hasDeeper = remainder.indexOf("/", 1) >= 0;
		if (!hasDeeper && lastComponentMatches(path)) greenEnd = path.length;
	}

	// anchor test: decorate decision.
	const firstInternalSlash = path.indexOf("/", 1);
	let decorate: boolean;
	if (firstInternalSlash < 0) {
		decorate = greenEnd === path.length; // whole string is a valid prefix
	} else {
		decorate = existsExpanded(path.slice(0, firstInternalSlash));
	}

	return { decorate, path, greenEnd, existEnd, fragment, fragmentState, action };
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
