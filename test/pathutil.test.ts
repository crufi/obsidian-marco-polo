// comment: unit tests for the pure path logic (no Obsidian needed).
// Run with `npm test` (Node's built-in runner; Node strips the TS types).
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
	analyzeSpec,
	clearStatCache,
	completePath,
	expandPath,
	setEnvMap,
} from "../pathutil.ts";

// a real on-disk fixture: <tmp>/sub (dir), <tmp>/sub/f.txt, <tmp>/.hidden (file).
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "marco-"));
fs.mkdirSync(path.join(tmp, "sub"));
fs.writeFileSync(path.join(tmp, "sub", "f.txt"), "x");
fs.writeFileSync(path.join(tmp, ".hidden"), "x");
// a single existing top-level component to exercise the one-component branch.
const topComponent = "/" + os.homedir().split("/").filter(Boolean)[0]; // e.g. /Users

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- expandPath: the security property and the variable rules ----

test("expandPath never performs command substitution", () => {
	// $( ... ) is not a $VAR, so it is left literal — it can never reach a shell.
	assert.equal(expandPath("$(rm -rf ~)"), "$(rm -rf ~)");
	assert.equal(expandPath("`reboot`"), "`reboot`");
});

test("expandPath substitutes $VAR and ${VAR} from the env map only", () => {
	setEnvMap({ FOO: "/data/foo" });
	assert.equal(expandPath("$FOO/x"), "/data/foo/x");
	assert.equal(expandPath("${FOO}/x"), "/data/foo/x");
	// unknown variable is left literal, never collapsed to "/x".
	assert.equal(expandPath("$NOPE/x"), "$NOPE/x");
	setEnvMap(process.env); // restore
});

test("expandPath expands a leading ~ but not ~otheruser", () => {
	assert.equal(expandPath("~"), os.homedir());
	assert.equal(expandPath("~/a"), os.homedir() + "/a");
	assert.equal(expandPath("~bob/a"), "~bob/a");
});

// ---- the decoration rule (sync mode = deterministic against the real fs) ----

const decorates = (s: string) => analyzeSpec(s, true).decorate;

test('"/" alone is not decorated', () => {
	assert.equal(decorates("/"), false);
});

test("one existing component is decorated, a missing one is not", () => {
	assert.equal(decorates(topComponent), true);
	assert.equal(decorates("/nonexistent-marco-xyz"), false);
});

test("a trailing slash decorates only when it exists", () => {
	assert.equal(decorates(topComponent + "/"), true);
	assert.equal(decorates("/nonexistent-marco-xyz/"), false);
});

test("content past a second separator decorates iff the first component exists", () => {
	assert.equal(decorates(tmp + "/sub"), true); // root (/var or /private) exists
	assert.equal(decorates(tmp + "/sub/f.txt"), true);
	assert.equal(decorates("/nonexistent-marco-xyz/a/b"), false);
});

test("greenEnd covers the deepest existing prefix only", () => {
	const spec = analyzeSpec(tmp + "/sub/missing-tail", true);
	assert.equal(spec.greenEnd, (tmp + "/sub").length);
	assert.equal(spec.decorate, true);
});

test("a complete #action fragment is recognized and split off", () => {
	const spec = analyzeSpec(tmp + "/sub/f.txt#open", true);
	assert.equal(spec.action, "open");
	assert.equal(spec.fragmentState, "valid");
	assert.equal(spec.path, tmp + "/sub/f.txt");
});

// ---- completion ----

test("completePath lists children, dirs first with a trailing slash", () => {
	const out = completePath(tmp + "/");
	assert.ok(out.some((p) => p.endsWith("/sub/")), "directory has trailing slash");
	// dotfiles stay hidden until the base is typed.
	assert.ok(!out.some((p) => p.endsWith("/.hidden")), "dotfile hidden by default");
	assert.ok(completePath(tmp + "/.").some((p) => p.endsWith("/.hidden")), "shown once typed");
});

test("completePath keeps the literal $VAR / ~ prefix instead of expanding it", () => {
	setEnvMap({ SHARE: tmp }); // $SHARE points at the fixture
	const out = completePath("$SHARE/");
	// the suggestion must read "$SHARE/sub/", NOT the expanded "<tmp>/sub/", so
	// accepting it keeps the link portable.
	assert.ok(out.includes("$SHARE/sub/"), `expected literal prefix, got ${out}`);
	assert.ok(!out.some((p) => p.startsWith(tmp)), "must not bake in the expanded path");
	setEnvMap(process.env);
});

// ---- embedded-absolute-var guard (the "/$SHARE" nonsense) ----

test("a $VAR that expands to an absolute path is not decorated mid-path", () => {
	setEnvMap({ SHARE: tmp }); // SHARE is absolute and exists
	assert.equal(analyzeSpec("$SHARE", true).decorate, true); // fine at the start
	assert.equal(analyzeSpec("$SHARE/sub", true).decorate, true); // fine at the start
	assert.equal(analyzeSpec("/$SHARE", true).decorate, false); // "//…" nonsense
	assert.equal(analyzeSpec("/x/$SHARE", true).decorate, false);
	setEnvMap(process.env);
});

test("a $VAR with a relative value is still allowed mid-path", () => {
	setEnvMap({ SUB: "sub" }); // relative value
	// <tmp>/$SUB -> <tmp>/sub, which exists and is a sensible path.
	assert.equal(analyzeSpec(tmp + "/$SUB", true).decorate, true);
	setEnvMap(process.env);
});

test("a literally-typed empty component (//) is not decorated", () => {
	// the OS collapses "//" and would stat it, but it is ill-formed as typed.
	assert.equal(analyzeSpec("/" + topComponent, true).decorate, false); // "//Users"
	assert.equal(analyzeSpec(tmp + "//sub", true).decorate, false); // mid-path "//"
});

test("completion is suppressed for ill-formed prefixes", () => {
	setEnvMap({ SHARE: tmp });
	assert.deepEqual(completePath("/$SHARE/"), []); // embedded absolute $VAR
	assert.deepEqual(completePath("/" + tmp + "/"), []); // literal leading "//"
	// the well-formed form still completes.
	assert.ok(completePath("$SHARE/").includes("$SHARE/sub/"));
	setEnvMap(process.env);
});

// ---- the async (non-blocking) cache used by the editor ----

test("async analyzeSpec returns a cached answer after a background stat", async () => {
	clearStatCache();
	// first sight: nothing cached yet, so the render path does not block and the
	// span is not yet decorated.
	assert.equal(analyzeSpec(tmp + "/sub").decorate, false);
	await wait(50); // let the background fs.stat resolve
	// now the root is cached, so the same span decorates without a blocking call.
	assert.equal(analyzeSpec(tmp + "/sub").decorate, true);
});
