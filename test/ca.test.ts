/**
 * @file Tests for proxy CA discovery and shell quoting.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { findProxyCa, shellQuote } from "../src/ca.ts";
import { PROXY_CA_DEFAULT } from "../src/constants.ts";

test("findProxyCa prefers SSL_CERT_FILE, then NODE_EXTRA_CA_CERTS, then the default", () => {
  const all = () => true;
  assert.equal(findProxyCa({ SSL_CERT_FILE: "/a", NODE_EXTRA_CA_CERTS: "/b" }, all), "/a");
  assert.equal(findProxyCa({ NODE_EXTRA_CA_CERTS: "/b" }, all), "/b");
  assert.equal(findProxyCa({}, all), PROXY_CA_DEFAULT);
});

test("findProxyCa skips candidates that do not exist and returns undefined when none does", () => {
  assert.equal(findProxyCa({ SSL_CERT_FILE: "/a", NODE_EXTRA_CA_CERTS: "/b" }, (p) => p === "/b"), "/b");
  assert.equal(findProxyCa({ SSL_CERT_FILE: "/a" }, () => false), undefined);
});

test("shellQuote single-quotes and escapes embedded quotes", () => {
  assert.equal(shellQuote("/a b/c.crt"), "'/a b/c.crt'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  assert.equal(shellQuote("$(rm -rf /)\"`"), "'$(rm -rf /)\"`'");
});
