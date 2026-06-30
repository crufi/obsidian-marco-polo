// comment: marco-polo - filesystem path autocomplete/validate/reveal in obsidian
import {
	App,
	Editor,
	EditorPosition,
	EditorSuggest,
	EditorSuggestContext,
	EditorSuggestTriggerInfo,
	MarkdownPostProcessorContext,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
} from "obsidian";
import {
	Decoration,
	DecorationSet,
	EditorView,
	ViewPlugin,
	ViewUpdate,
} from "@codemirror/view";
import { RangeSetBuilder, StateEffect } from "@codemirror/state";
import { execFile } from "child_process";
import {
	Action,
	analyzeSpec,
	classifyPath,
	clearStatCache,
	completePath,
	expandPath,
	looksLikePath,
	onStatResolved,
	runCommandTemplate,
	setEnvMap,
	Spec,
} from "./pathutil";

// Source the login shell's exported environment once, as inert data. ONLY
// `printenv` runs — the user's path text is never passed to the shell, so this
// adds no command-execution surface (the shell does run the user's own dotfiles,
// which is their trusted code). `-ilc` makes it interactive + login so exports
// from .zshrc as well as .zprofile/.zshenv are captured. Exported vars only.
function sourceShellEnv(shell: string): Promise<Record<string, string>> {
	return new Promise((resolve, reject) => {
		execFile(shell, ["-ilc", "printenv"], { timeout: 4000, maxBuffer: 1 << 20 }, (err, stdout) => {
			if (err && !stdout) return reject(err);
			const map: Record<string, string> = {};
			for (const line of stdout.split("\n")) {
				const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
				if (m) map[m[1]] = m[2];
			}
			resolve(map);
		});
	});
}

// electron's shell is the safe default for open/reveal (no shell parsing).
// loaded lazily; typed loosely since electron types are an obsidian-runtime
// external and are not present at build time.
interface ElectronShell {
	openPath(path: string): Promise<string>;
	showItemInFolder(path: string): void;
}
function electronShell(): ElectronShell | null {
	try {
		return (require("electron") as { shell: ElectronShell }).shell;
	} catch {
		return null;
	}
}

interface MarcoPoloSettings {
	fileClickAction: Action;
	// when blank, use electron shell. otherwise a command with a {path} token.
	openDirCommand: string;
	revealFileCommand: string;
	// applies to the editor only; reading mode always follows a plain click.
	requireModifierClick: boolean;
	// css color for valid paths; "" falls back to the theme green.
	validColor: string;
	// source the login shell's exported env so $VAR (e.g. $SHARE) resolves.
	sourceShellEnv: boolean;
}

const DEFAULT_SETTINGS: MarcoPoloSettings = {
	fileClickAction: "reveal",
	openDirCommand: "",
	revealFileCommand: "",
	requireModifierClick: true,
	validColor: "",
	sourceShellEnv: true,
};

// matches an inline-code span on a single line: `...`
const CODE_SPAN = /`([^`\n]+)`/g;

export default class MarcoPoloPlugin extends Plugin {
	settings: MarcoPoloSettings = DEFAULT_SETTINGS;

	async onload() {
		await this.loadSettings();

		this.registerEditorSuggest(new PathSuggest(this.app, this));
		this.registerEditorExtension(makeValidationPlugin());
		this.registerMarkdownPostProcessor((el, ctx) => this.decorateReadingMode(el, ctx));

		this.registerDomEvent(document, "mousedown", (evt) => {
			const target = evt.target as HTMLElement;
			const span = target.closest?.(".mp-path-valid") as HTMLElement | null;
			if (!span) return;
			// reading/preview always follows a plain click; the modifier rule
			// only guards the live editor, where text editing must stay intact.
			const inEditor = !!target.closest(".cm-editor");
			if (inEditor && this.settings.requireModifierClick && !(evt.metaKey || evt.ctrlKey)) {
				return;
			}
			evt.preventDefault();
			const raw = span.getAttribute("data-mp-path") ?? span.textContent ?? "";
			const action = (span.getAttribute("data-mp-action") as Action) || null;
			this.activatePath(raw, action);
		});

		this.applyValidColor();
		void this.loadShellEnv(); // async; fills the env map shortly after load

		this.addCommand({
			id: "refresh-env",
			name: "Refresh environment variables",
			callback: async () => {
				await this.loadShellEnv();
				new Notice("Marco Polo: environment refreshed");
			},
		});

		this.addCommand({
			id: "insert-path",
			name: "Insert local path…",
			editorCallback: (editor) => {
				new PathPickerModal(this.app, "~/", (path) => {
					editor.replaceSelection("`" + path + "`");
				}).open();
			},
		});

		this.addSettingTab(new MarcoPoloSettingTab(this.app, this));
	}

	// push the chosen color into a css variable the stylesheet reads.
	applyValidColor() {
		const v = this.settings.validColor;
		if (v) document.body.style.setProperty("--mp-valid-color", v);
		else document.body.style.removeProperty("--mp-valid-color");
	}

	// build the environment map used for $VAR expansion. when enabled (and not
	// Windows), merge the login shell's exported vars over process.env so things
	// like $SHARE resolve; otherwise just use process.env.
	async loadShellEnv() {
		if (!this.settings.sourceShellEnv || process.platform === "win32") {
			setEnvMap(process.env);
		} else {
			const shell = process.env.SHELL || "/bin/zsh";
			try {
				const shellEnv = await sourceShellEnv(shell);
				setEnvMap({ ...process.env, ...shellEnv });
			} catch (e) {
				console.error("[marco-polo] could not source shell environment:", e);
				setEnvMap(process.env);
			}
		}
		specCache.clear(); // re-validate spans against the new env
		clearStatCache(); // expansions changed; drop cached existence answers
	}

	// open a directory, or reveal/open a file. `override` comes from a #open
	// or #reveal fragment and wins over the configured default.
	activatePath(raw: string, override: Action | null) {
		const kind = classifyPath(raw);
		if (kind === "missing") {
			new Notice(`Marco Polo: path not found\n${raw}`);
			return;
		}
		const expanded = expandPath(raw);
		const shell = electronShell();
		const action: Action = override ?? (kind === "dir" ? "open" : this.settings.fileClickAction);

		if (action === "open") {
			if (kind === "dir" && this.settings.openDirCommand) {
				runCommandTemplate(this.settings.openDirCommand, expanded);
			} else if (shell) {
				shell.openPath(expanded);
			}
		} else {
			// reveal
			if (this.settings.revealFileCommand) {
				runCommandTemplate(this.settings.revealFileCommand, expanded);
			} else if (shell) {
				shell.showItemInFolder(expanded);
			}
		}
	}

	// reading mode: rebuild path-like <code> spans into green/red/fragment parts.
	decorateReadingMode(el: HTMLElement, _ctx: MarkdownPostProcessorContext) {
		el.querySelectorAll("code").forEach((code) => {
			const inner = code.textContent ?? "";
			if (!looksLikePath(inner)) return;
			const spec = analyzeSpec(inner, true); // sync: reading mode renders once
			if (!spec.decorate) return; // no valid anchor -> leave as plain code
			code.empty();
			code.classList.add("mp-path");
			const green = spec.path.slice(0, spec.greenEnd);
			const red = spec.path.slice(spec.greenEnd);
			if (green) {
				const s = code.createSpan({ text: green, cls: "mp-path-valid" });
				s.setAttribute("data-mp-path", spec.path.slice(0, spec.existEnd));
				if (spec.action) s.setAttribute("data-mp-action", spec.action);
				s.setAttribute("aria-label", "Open in file manager");
			}
			if (red) code.createSpan({ text: red, cls: "mp-path-invalid" });
			if (spec.fragment) {
				const fragCls = spec.fragmentState === "valid" ? "mp-path-frag" : "mp-path-frag-pending";
				code.createSpan({ text: spec.fragment, cls: fragCls });
			}
		});
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

// ---------- autocomplete (dropdown via EditorSuggest) ----------

class PathSuggest extends EditorSuggest<string> {
	constructor(app: App, private plugin: MarcoPoloPlugin) {
		super(app);
		// footer bar: brands the popup and teaches the controls.
		this.setInstructions([
			{ command: "Marco Polo", purpose: "" },
			{ command: "↑↓", purpose: "navigate" },
			{ command: "↵ / ⇥", purpose: "use" },
			{ command: "esc", purpose: "dismiss" },
		]);
	}

	onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
		const before = editor.getLine(cursor.line).slice(0, cursor.ch);
		const openTick = before.lastIndexOf("`");
		if (openTick === -1) return null;
		// even number of ticks before openTick => we sit inside an open span.
		const ticksBefore = (before.slice(0, openTick).match(/`/g) || []).length;
		if (ticksBefore % 2 !== 0) return null;
		const partial = before.slice(openTick + 1);
		if (!looksLikePath(partial)) return null;
		return {
			start: { line: cursor.line, ch: openTick + 1 },
			end: cursor,
			query: partial,
		};
	}

	getSuggestions(ctx: EditorSuggestContext): string[] {
		return completePath(ctx.query);
	}

	renderSuggestion(value: string, el: HTMLElement) {
		const isDir = value.endsWith("/");
		el.addClass("mp-suggestion");
		const base = value.replace(/\/$/, "").split("/").pop() ?? value;
		el.createSpan({
			text: base + (isDir ? "/" : ""),
			cls: isDir ? "mp-sugg-dir" : "mp-sugg-file",
		});
	}

	selectSuggestion(value: string) {
		if (!this.context) return;
		const { editor, start, end } = this.context;
		editor.replaceRange(value, start, end);
		editor.setCursor({ line: start.line, ch: start.ch + value.length });
		// directories keep a trailing slash, so the next keystroke continues
		// completing into them automatically.
	}
}

// ---------- insert-path picker (drill-down browser) ----------

interface PickItem {
	label: string; // text shown in the row
	path: string; // raw path this item resolves to
	isDir: boolean;
	insert: boolean; // true => commit this path; false => an entry to drill/insert
}

class PathPickerModal extends SuggestModal<PickItem> {
	constructor(app: App, private initialQuery: string, private onPick: (path: string) => void) {
		super(app);
		this.setPlaceholder("Type a path: ~, $VAR or /  ·  Enter a folder to go in, or pick “Insert …”");
		this.setInstructions([
			{ command: "Marco Polo", purpose: "" },
			{ command: "↵", purpose: "open folder / insert file" },
			{ command: "esc", purpose: "cancel" },
		]);
	}

	onOpen() {
		super.onOpen();
		this.inputEl.value = this.initialQuery;
		this.inputEl.dispatchEvent(new Event("input"));
	}

	getSuggestions(query: string): PickItem[] {
		const q = query.trim();
		const items: PickItem[] = [];
		// let the user commit the path they have typed, when it resolves.
		if (q) {
			const kind = classifyPath(q);
			if (kind !== "missing") {
				items.push({ label: `Insert  ${q}`, path: q, isDir: kind === "dir", insert: true });
			}
		}
		for (const p of completePath(q)) {
			items.push({ label: p, path: p, isDir: p.endsWith("/"), insert: false });
		}
		return items;
	}

	renderSuggestion(item: PickItem, el: HTMLElement) {
		el.addClass("mp-suggestion");
		if (item.insert) {
			el.createSpan({ text: "↵ " + item.label, cls: "mp-pick-insert" });
		} else {
			const base = item.path.replace(/\/$/, "").split("/").pop() ?? item.path;
			el.createSpan({ text: base + (item.isDir ? "/" : ""), cls: item.isDir ? "mp-sugg-dir" : "mp-sugg-file" });
		}
	}

	onChooseSuggestion(item: PickItem) {
		if (!item.insert && item.isDir) {
			// drill in: reopen the picker seeded at the chosen folder.
			new PathPickerModal(this.app, item.path, this.onPick).open();
		} else {
			this.onPick(item.path);
		}
	}
}

// ---------- live validation (CM6 decorations) ----------

// cache analyzed specs, cleared on a timer so fs changes are eventually seen.
const specCache = new Map<string, Spec>();
let lastClear = Date.now();
function cachedSpec(inner: string): Spec {
	if (Date.now() - lastClear > 5000) {
		specCache.clear();
		lastClear = Date.now();
	}
	let s = specCache.get(inner);
	if (s === undefined) {
		s = analyzeSpec(inner);
		specCache.set(inner, s);
	}
	return s;
}

// dispatched (as a no-op transaction) when a background stat resolves, to ask
// the view to repaint without an edit. Decorations don't depend on the
// selection, so cursor moves no longer trigger a rebuild.
const mpRerender = StateEffect.define<null>();

function makeValidationPlugin() {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;
			unsub: () => void;
			constructor(view: EditorView) {
				this.decorations = this.build(view);
				// a background existence check finished: drop stale specs and ask
				// this view to rebuild. Fires on a fresh tick (the fs callback), so
				// dispatching here is safe.
				this.unsub = onStatResolved(() => {
					specCache.clear();
					view.dispatch({ effects: mpRerender.of(null) });
				});
			}
			destroy() {
				this.unsub();
			}
			update(u: ViewUpdate) {
				const rerender = u.transactions.some((t) => t.effects.some((e) => e.is(mpRerender)));
				if (u.docChanged || u.viewportChanged || rerender) {
					this.decorations = this.build(u.view);
				}
			}
			build(view: EditorView): DecorationSet {
				const builder = new RangeSetBuilder<Decoration>();
				for (const { from, to } of view.visibleRanges) {
					const text = view.state.sliceDoc(from, to);
					let m: RegExpExecArray | null;
					CODE_SPAN.lastIndex = 0;
					while ((m = CODE_SPAN.exec(text)) !== null) {
						const inner = m[1];
						if (!looksLikePath(inner)) continue;
						const spec = cachedSpec(inner);
						if (!spec.decorate) continue; // no valid anchor -> leave as plain code
						const base = from + m.index + 1; // first char inside the backticks
						const greenEnd = base + spec.greenEnd;
						const pathEnd = base + spec.path.length;
						const innerEnd = base + inner.length;

						if (spec.greenEnd > 0) {
							builder.add(
								base,
								greenEnd,
								Decoration.mark({
									class: "mp-path mp-path-valid",
									attributes: {
										"data-mp-path": spec.path.slice(0, spec.existEnd),
										...(spec.action ? { "data-mp-action": spec.action } : {}),
									},
								})
							);
						}
						if (greenEnd < pathEnd) {
							builder.add(greenEnd, pathEnd, Decoration.mark({ class: "mp-path mp-path-invalid" }));
						}
						if (pathEnd < innerEnd) {
							const fragCls =
								spec.fragmentState === "valid" ? "mp-path mp-path-frag" : "mp-path mp-path-frag-pending";
							builder.add(pathEnd, innerEnd, Decoration.mark({ class: fragCls }));
						}
					}
				}
				return builder.finish();
			}
		},
		{ decorations: (v) => v.decorations }
	);
}

// ---------- settings tab ----------

class MarcoPoloSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: MarcoPoloPlugin) {
		super(app, plugin);
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("File click action")
			.setDesc("Default for files. Override per link with a #open or #reveal fragment.")
			.addDropdown((d) =>
				d
					.addOption("reveal", "Reveal in file manager")
					.addOption("open", "Open with default app")
					.setValue(this.plugin.settings.fileClickAction)
					.onChange(async (v) => {
						this.plugin.settings.fileClickAction = v as Action;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Valid path color")
			.setDesc("Color for paths that exist. Use the reset arrow to fall back to the theme green.")
			.addColorPicker((c) =>
				c.setValue(this.plugin.settings.validColor || "#22c55e").onChange(async (v) => {
					this.plugin.settings.validColor = v;
					this.plugin.applyValidColor();
					await this.plugin.saveSettings();
				})
			)
			.addExtraButton((b) =>
				b
					.setIcon("rotate-ccw")
					.setTooltip("Reset to theme default")
					.onClick(async () => {
						this.plugin.settings.validColor = "";
						this.plugin.applyValidColor();
						await this.plugin.saveSettings();
						this.display();
					})
			);

		new Setting(containerEl)
			.setName("Require Cmd/Ctrl-click in the editor")
			.setDesc("Keeps normal text editing intact in Live Preview. Reading mode always follows a plain click.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.requireModifierClick).onChange(async (v) => {
					this.plugin.settings.requireModifierClick = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Resolve shell variables ($SHARE, etc.)")
			.setDesc(
				"Source your login shell once at startup so exported variables from your shell config resolve. " +
					"Only exported vars are seen. After editing your dotfiles, run the command " +
					"'Marco Polo: Refresh environment variables'. Ignored on Windows."
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.sourceShellEnv).onChange(async (v) => {
					this.plugin.settings.sourceShellEnv = v;
					await this.plugin.saveSettings();
					await this.plugin.loadShellEnv();
				})
			);

		new Setting(containerEl)
			.setName("Custom open-directory command")
			.setDesc(
				'Optional. Use {path} for the target. Blank uses the cross-platform default. ' +
					'e.g. macOS: open -a "Path Finder" {path} · Linux: xdg-open {path} · Windows: explorer {path}'
			)
			.addText((t) =>
				t
					.setPlaceholder("(blank = system default)")
					.setValue(this.plugin.settings.openDirCommand)
					.onChange(async (v) => {
						this.plugin.settings.openDirCommand = v.trim();
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Custom reveal-file command")
			.setDesc(
				"Optional. Use {path} for the target. Blank uses the cross-platform default " +
					"(highlights the file in your file manager)."
			)
			.addText((t) =>
				t
					.setPlaceholder("(blank = system default)")
					.setValue(this.plugin.settings.revealFileCommand)
					.onChange(async (v) => {
						this.plugin.settings.revealFileCommand = v.trim();
						await this.plugin.saveSettings();
					})
			);
	}
}
