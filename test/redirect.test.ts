import { describe, expect, it } from "vitest";
import { canonicalRedirectHref, isSafeRedirectUrl, shouldRewriteLink } from "../src/redirect";

describe("isSafeRedirectUrl", () => {
  it("allows http and https destinations", () => {
    expect(isSafeRedirectUrl("https://example.com/path?q=1")).toBe(true);
    expect(isSafeRedirectUrl("http://example.com")).toBe(true);
  });

  it("rejects open-redirect and non-http schemes", () => {
    expect(isSafeRedirectUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeRedirectUrl("data:text/html,hi")).toBe(false);
    expect(isSafeRedirectUrl("mailto:ada@example.com")).toBe(false);
    expect(isSafeRedirectUrl("tel:+15555550100")).toBe(false);
    expect(isSafeRedirectUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeRedirectUrl("ftp://files.example")).toBe(false);
    expect(isSafeRedirectUrl("//evil.example/phish")).toBe(false);
    expect(isSafeRedirectUrl("/relative/path")).toBe(false);
    expect(isSafeRedirectUrl("")).toBe(false);
    expect(isSafeRedirectUrl("   ")).toBe(false);
    expect(isSafeRedirectUrl("not a url")).toBe(false);
    expect(isSafeRedirectUrl("https://user:pass@example.com/phish")).toBe(false);
    expect(isSafeRedirectUrl("https://example.com/\r\nLocation: https://evil.example")).toBe(false);
    expect(isSafeRedirectUrl("https://example.com/\nfoo")).toBe(false);
  });

  it("normalizes backslash URLs onto the parsed host", () => {
    expect(canonicalRedirectHref("https://example.com\\@evil.com")).toBe("https://example.com/@evil.com");
    expect(canonicalRedirectHref("https://example.com/docs")).toBe("https://example.com/docs");
    expect(canonicalRedirectHref("javascript:alert(1)")).toBeNull();
  });
});

describe("shouldRewriteLink", () => {
  it("rewrites only absolute http(s) and skips mailto/tel/#", () => {
    expect(shouldRewriteLink("https://example.com")).toBe(true);
    expect(shouldRewriteLink("mailto:ada@example.com")).toBe(false);
    expect(shouldRewriteLink("tel:+15555550100")).toBe(false);
    expect(shouldRewriteLink("#section")).toBe(false);
    expect(shouldRewriteLink("javascript:alert(1)")).toBe(false);
    expect(shouldRewriteLink("cid:inline-image@local")).toBe(false);
  });
});
