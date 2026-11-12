import test from "node:test";
import assert from "node:assert/strict";
import { parseBrowserOrigin } from "../desktop/home/browser-origin.mjs";

test("the desktop authorization accepts an exact HTTP(S) origin", () => {
  assert.equal(
    parseBrowserOrigin(" HTTPS://EXAMPLE.COM:443/ "),
    "https://example.com",
  );
  assert.equal(
    parseBrowserOrigin("http://example.com:80"),
    "http://example.com",
  );
  for (const input of [
    undefined,
    "example.com",
    "file:///tmp/example",
    "http://example.com:8080",
    "https://user:password@example.com",
    "https://example.com?query",
    "https://example.com/#fragment",
    "https://example.com/path",
    "https://example.com//",
    "https://example.com\\path",
  ])
    assert.equal(parseBrowserOrigin(input), undefined);
});
