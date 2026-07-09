import tseslint from "typescript-eslint";
export default tseslint.config(
  ...tseslint.configs.recommendedTypeChecked,
  { languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } } },
  { ignores: ["main.js", "test/**", "electron.d.ts", "eslint.config.mjs"] }
);
