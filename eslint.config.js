const expoConfig = require('eslint-config-expo/flat');
const i18next = require('eslint-plugin-i18next');

module.exports = [
  ...expoConfig,
  {
    // shoulda/ and fuel/ are standalone projects with their own tooling; they move to their own repos.
    ignores: ['dist/*', 'drizzle/*', 'node_modules/*', '.expo/*', 'shoulda/**', 'fuel/**'],
  },
  {
    // "No hardcoded strings in the UI" is a build rule, not a convention people remember.
    files: ['src/app/**/*.tsx', 'src/features/**/*.tsx', 'src/ui/**/*.tsx'],
    plugins: { i18next },
    rules: {
      'i18next/no-literal-string': [
        'error',
        {
          mode: 'jsx-text-only',
          'should-validate-template': true,
        },
      ],
    },
  },
  {
    // The repository layer is the only place that may speak SQL.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/db/**', 'src/repositories/**', 'src/state/bootstrap.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['drizzle-orm', 'drizzle-orm/*', '@/db', '@/db/*'],
              message: 'Go through src/repositories — nothing above the repository layer touches the database.',
            },
          ],
        },
      ],
    },
  },
];
