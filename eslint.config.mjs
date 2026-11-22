import gts from "gts";

export default [
    // Flat-config replacement for the no-longer-supported .eslintignore.
    // Use glob form ("dir/**"); trailing-slash patterns are unreliable as
    // flat-config global ignores. node_modules/ and .git/ are auto-ignored.
    //
    // apps/** is ignored here because gts uses typed linting bound to the root
    // tsconfig, which does not include apps/* (each app has its own tsconfig).
    // Apps are linted by their own eslint/next config via `turbo lint`, and
    // formatted by Prettier directly (`pnpm format`) — they are intentionally
    // NOT in .prettierignore, so formatting still covers them.
    {
        ignores: ["apps/**", "**/build/**", "**/.turbo/**", "**/.next/**"],
    },
    ...gts,
    // Formatting is owned by Prettier directly (run `pnpm format`), not by
    // ESLint. Disable eslint-plugin-prettier so ESLint stops trying to format:
    // this kills the ESLintCircularFixesWarning and lets gts lint files (e.g.
    // apps/*) that live outside the root tsconfig's typed project.
    // `quotes` is off because gts wants single quotes but our Prettier config
    // emits double — leaving Prettier as the single source of truth.
    {
        rules: {
            "prettier/prettier": "off",
            quotes: "off",
        },
    },
];
