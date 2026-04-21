import "@testing-library/jest-dom/vitest";
import { afterEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

// Reset the DOM + any pending timers / mocks after every test so state
// does not leak between files.
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  localStorage.clear();
  sessionStorage.clear();
});

// JSDOM doesn't implement `window.matchMedia` — a lot of the Tailwind /
// responsive components use it, so we stub it out.
Object.defineProperty(window, "matchMedia", {
  writable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// JSDOM doesn't implement `scrollTo` / ResizeObserver either; stub them.
Object.defineProperty(window, "scrollTo", { value: vi.fn(), writable: true });
// @ts-ignore
window.HTMLElement.prototype.scrollIntoView = vi.fn();

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-ignore
window.ResizeObserver = ResizeObserverStub;
