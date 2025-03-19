const prettier = require('eslint-config-prettier')
const prettierPlugin = require('eslint-plugin-prettier')

/** @type {import("eslint").Linter.FlatConfig[]} */
module.exports = [
  {
    ignores: ['node_modules/', 'dist/'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      sourceType: 'script',
      ecmaVersion: 'latest',
    },
    plugins: {
      prettier: prettierPlugin,
    },
    rules: {
      ...prettier.rules,
      'prettier/prettier': 'error',
    },
  },
]
