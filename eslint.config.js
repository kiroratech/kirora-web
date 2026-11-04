import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'coverage', 'examples'] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // Keeps the SDK consistent as it grows.
    files: ['src/**/*.ts'],
    rules: {
      eqeqeq: 'error',
      // The logger is the one way to the console, so `logLevel` applies everywhere.
      'no-console': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { accessibility: 'no-public' },
      ],
    },
  },
  {
    files: ['src/utils/log.ts', 'src/cdn.ts'],
    rules: { 'no-console': 'off' },
  },
  {
    // Tests read stubbed request bodies and match with `expect.any()`.
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
);
