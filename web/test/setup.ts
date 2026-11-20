import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

// Every island test talks to the API through the stub in ./api-stub (the
// real helper needs a Supabase session). The tests of the real module undo
// this with vi.unmock.
vi.mock("../src/api", async () => (await import("./api-stub")).fakeApiModule);
