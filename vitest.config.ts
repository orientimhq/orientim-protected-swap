import { configDefaults, defineConfig } from 'vitest/config';

// The integrations are packages of their own, with their own tests (see .github/workflows/ci.yml).
export default defineConfig({ test: { exclude: [...configDefaults.exclude, 'integrations/**'] } });
