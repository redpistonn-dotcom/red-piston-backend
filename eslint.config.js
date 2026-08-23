import js from '@eslint/js';
import globals from 'globals';

export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      // Warn on unused variables; ignore _prefixed params (intentional ignores)
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Console is fine — this is a server
      'no-console': 'off',
      // Allow reassigning function params (common in Express middleware)
      'no-param-reassign': 'off',
      // Allow == null checks (common Prisma pattern)
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      // No var
      'no-var': 'error',
      // Prefer const
      'prefer-const': 'warn',
    },
  },
  {
    // Ignore test files and scripts from some rules
    files: ['tests/**/*.js', 'prisma/**/*.js', 'scripts/**/*.js'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
];
