import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { isCliEntrypoint } from "../../packages/cli/src/shared.ts";

describe("CLI entrypoint detection", () => {
  it("matches a native path for this module", () => {
    const meta = import.meta.url;
    const native = fileURLToPath(meta);
    expect(isCliEntrypoint(meta, native)).toBe(true);
  });

  it("treats backslash argv[1] as equivalent to the forward-slash path", () => {
    const meta = import.meta.url;
    const native = fileURLToPath(meta);
    const backslash = native.replace(/\//g, "\\");
    expect(isCliEntrypoint(meta, backslash)).toBe(true);
  });

  it("does not treat an unrelated path as main", () => {
    expect(isCliEntrypoint(import.meta.url, "/tmp/some-other-script.mjs")).toBe(
      false,
    );
  });
});
