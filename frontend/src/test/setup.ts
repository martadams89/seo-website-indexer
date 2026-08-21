import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => cleanup());

if (!window.requestAnimationFrame) {
  window.requestAnimationFrame = callback => window.setTimeout(() => callback(performance.now()), 0);
  window.cancelAnimationFrame = handle => window.clearTimeout(handle);
}
