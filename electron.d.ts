// Minimal ambient types for the Electron shell API. Electron is an
// obsidian-runtime external (provided at runtime, not bundled) and ships no
// types in this project, so declare just the slice Marco Polo uses.
declare module "electron" {
	export const shell: {
		openPath(path: string): Promise<string>;
		showItemInFolder(path: string): void;
	};
}
