import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Auto-cleanup is only registered when vitest globals are enabled; this project
// runs with `globals: false`, so unmount between tests explicitly. Without it,
// mounted trees pile up in the shared document and queries match many nodes.
afterEach(() => {
  cleanup();
});
