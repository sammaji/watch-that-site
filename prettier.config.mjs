/** @type {import('prettier').Config} */
const prettier = {
    useTabs: false,
    tabWidth: 4,
    trailingComma: "all",
    semi: true,
    arrowParens: "avoid",
    bracketSameLine: true,
    experimentalTernaries: true,
    plugins: [
        "prettier-plugin-organize-imports",
        "prettier-plugin-tailwindcss",
        "prettier-plugin-sql",
    ],
    overrides: [
        {
            files: "*.sql",
            options: {
                parser: "sql",
            },
        },
    ],
};

/** @type {import('prettier-plugin-sql').SqlBaseOptions} */
const prettierSql = {
    language: "postgresql",
    database: "postgresql",
    dataTypeCase: "upper",
    keywordCase: "upper",
    functionCase: "upper",
    identifierCase: "lower",
    denseOperators: true,
};

const config = {
    ...prettier,
    ...prettierSql,
};

export default config;
