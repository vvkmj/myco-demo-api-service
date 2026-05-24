import type { Config } from '@jest/types';

const config: Config.InitialOptions = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  testMatch: [
    '**/__integrationtest__/tests/**/*.test.ts'
  ],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@packages/(.*)$': '<rootDir>/../../packages/$1'
  },
  reporters: ['default', 'jest-junit'],
  detectOpenHandles: true,
  forceExit: true,
  setupFilesAfterEnv: ['<rootDir>/__integrationtest__/setup/jest.setup.ts'],
  globalSetup: '<rootDir>/__integrationtest__/setup/global-setup.ts',
  globalTeardown: '<rootDir>/__integrationtest__/setup/teardown.ts',
  testTimeout: 60000,
  verbose: true,
  maxWorkers: 1, // Run tests serially to avoid conflicts
  testPathIgnorePatterns: [
    '/node_modules/',
    '/dist/'
  ],
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/dist/',
    '/__integrationtest__/**/*',
  ]
};

export default config;
