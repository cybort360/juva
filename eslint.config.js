// @ts-check
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const eslintPluginPrettierRecommended = require('eslint-plugin-prettier/recommended');

module.exports = defineConfig([
  expoConfig,
  eslintPluginPrettierRecommended,
  {
    ignores: [
      'node_modules/**',
      '.expo/**',
      '.tmp-domain/**',
      'dist/**',
      'web-build/**',
      'android/**',
      'ios/**',
      'preview/**',
      'services/api/dist/**',
      'services/api/.tmp-api/**',
      'expo-env.d.ts',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      // Money and provenance rules only hold if nothing quietly becomes `any`.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'import/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'always',
          alphabetize: { order: 'asc', caseInsensitive: true },
        },
      ],
    },
  },
  {
    // The API service is plain Node, with no React or React Native globals.
    files: ['services/api/**/*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
]);
