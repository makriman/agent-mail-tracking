import { describe, expect, it } from "vitest";
import {
  collectUrls,
  extractHtmlHrefUrls,
  extractTextUrls,
  hasTrackingPixel,
  injectPixel,
  instrument,
  pixelTag,
  proseToBareHtml,
  replaceTextUrls,
  rewriteHtmlHrefs,
} from "../src/instrument";

const map = new Map<string, string>([
  ["https://example.com/docs", "https://track.example/c/tok-docs"],
  ["https://example.com", "https://track.example/c/tok-root"],
]);

describe("URL extraction", () => {
  it("finds http(s) URLs in prose and strips trailing punctuation", () => {
    const urls = extractTextUrls("See https://example.com/docs, then https://example.com.");
    expect(urls).toEqual(["https://example.com/docs", "https://example.com"]);
  });

  it("skips mailto, tel, and hash hrefs in HTML", () => {
    const html = `
      <a href="https://example.com">ok</a>
      <a href="mailto:ada@example.com">mail</a>
      <a href="tel:+15555550100">call</a>
      <a href="#section">jump</a>
      <a href="javascript:alert(1)">nope</a>
    `;
    expect(extractHtmlHrefUrls(html)).toEqual(["https://example.com"]);
  });

  it("collects from text in plain modes and hrefs in html mode", () => {
    expect(collectUrls("plain_looking", "Go https://a.example/x", "<a href='https://ignored.example'>x</a>")).toEqual([
      "https://a.example/x",
    ]);
    expect(collectUrls("html", "https://plain.example", '<a href="https://html.example">x</a>')).toEqual([
      "https://html.example",
    ]);
  });
});

describe("plain_looking", () => {
  it("rewrites links in text and builds a bare HTML twin with pixel", () => {
    const text = "Hello Ada,\n\nSee https://example.com/docs\nand write back.";
    const out = instrument({
      mode: "plain_looking",
      text,
      linkMap: map,
      pixelUrl: "https://track.example/o/tok-open",
    });
    expect(out.open_tracking).toBe(true);
    expect(out.text).toContain("https://track.example/c/tok-docs");
    expect(out.text).not.toContain("https://example.com/docs");
    expect(out.html).toMatch(/<p>Hello Ada,<\/p>/);
    expect(out.html).toContain("<br>");
    expect(out.html).toContain('<a href="https://track.example/c/tok-docs">https://example.com/docs</a>');
    expect(out.html).not.toContain('tok-root">https://example.com</a>/docs');
    expect(out.html).toContain(pixelTag("https://track.example/o/tok-open"));
    expect(out.html).not.toMatch(/style\s*=/i);
    expect(out.html).not.toMatch(/<style/i);
  });

  it("wraps double newlines as paragraphs only", () => {
    const html = proseToBareHtml("A\n\nB\nC", new Map());
    expect(html).toBe("<p>A</p>\n<p>B<br>\nC</p>");
  });
});

describe("plain_only", () => {
  it("keeps text, rewrites links, and disables open tracking", () => {
    const out = instrument({
      mode: "plain_only",
      text: "Hi https://example.com",
      linkMap: map,
      pixelUrl: "https://track.example/o/should-not-appear",
    });
    expect(out.open_tracking).toBe(false);
    expect(out.html).toBeNull();
    expect(out.text).toBe("Hi https://track.example/c/tok-root");
    expect(out.text).not.toContain("/o/");
  });
});

describe("html mode", () => {
  it("rewrites http(s) hrefs, skips mailto/tel/#, injects pixel when missing", () => {
    const html = `<html><body><p><a href="https://example.com">home</a> <a href="mailto:a@b.c">m</a> <a href="#top">t</a></p></body></html>`;
    const out = instrument({
      mode: "html",
      html,
      linkMap: map,
      pixelUrl: "https://track.example/o/tok-open",
    });
    expect(out.open_tracking).toBe(true);
    expect(out.html).toContain('href="https://track.example/c/tok-root"');
    expect(out.html).toContain('href="mailto:a@b.c"');
    expect(out.html).toContain('href="#top"');
    expect(out.html).toContain('src="https://track.example/o/tok-open"');
    expect(out.html).toMatch(/<\/body>/i);
  });

  it("does not inject a second pixel when one is already present", () => {
    const html = `<p>Hi</p><img src="https://track.example/o/existing.token" width="1" height="1" alt="">`;
    const injected = injectPixel(html, "https://track.example/o/new");
    expect(injected).toBe(html);
    expect(hasTrackingPixel(html)).toBe(true);
  });
});

describe("rewrite helpers", () => {
  it("replaces longer URLs first so prefixes do not clobber paths", () => {
    const text = replaceTextUrls("https://example.com/docs and https://example.com", map);
    expect(text).toBe("https://track.example/c/tok-docs and https://track.example/c/tok-root");
  });

  it("rewrites hrefs without touching other attributes", () => {
    const html = rewriteHtmlHrefs('<a class="x" href="https://example.com">z</a>', map);
    expect(html).toBe('<a class="x" href="https://track.example/c/tok-root">z</a>');
  });
});
