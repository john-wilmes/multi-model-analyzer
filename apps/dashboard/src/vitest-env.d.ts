// Augment the local vitest instance (v4) with jest-dom matchers.
// The root node_modules/@testing-library/jest-dom/types/vitest.d.ts targets
// the root vitest (v3) and does not apply to the dashboard's local vitest (v4),
// so we re-declare the augmentation here against the correct module identity.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
  interface Assertion<T = any>
    extends TestingLibraryMatchers<any, T> {}
  interface AsymmetricMatchersContaining
    extends TestingLibraryMatchers<any, any> {}
}
