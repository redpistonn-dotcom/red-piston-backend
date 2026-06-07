/**
 * Global test setup — runs before every test file.
 * Sets env vars so JWT signing works without a real .env file.
 * Must be set before any module that imports jwt or helpers is loaded.
 */
process.env.JWT_SECRET          = 'test-jwt-secret-32-chars-minimum!!';
process.env.JWT_REFRESH_SECRET  = 'test-refresh-secret-32-chars-min!!';
process.env.JWT_EXPIRES_IN      = '8h';
process.env.JWT_REFRESH_EXPIRES_IN = '30d';
process.env.NODE_ENV            = 'test';
