/** Integration-style tests run against a real PostgreSQL (see README: DATABASE_URL_TEST). */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: 'test/.*\\.e2e-spec\\.ts$|src/.*\\.spec\\.ts$',
  transform: { '^.+\\.ts$': ['ts-jest', {}] },
  testEnvironment: 'node',
  testTimeout: 30000,
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  globalSetup: '<rootDir>/test/global-setup.ts',
};
