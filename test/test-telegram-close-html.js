import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TG, escapeTelegramHtml } from "../utils/telegram-id.js";

describe("escapeTelegramHtml", () => {
  it("escapes less-than in close reasons", () => {
    const r = escapeTelegramHtml("fee/TVL 0.92% < min 3%");
    assert.ok(!r.includes("<"));
    assert.match(r, /&lt; min/);
  });
});

describe("TG.closed", () => {
  it("renders low-yield reason without raw <", () => {
    const html = TG.closed({
      pair: "CATWIF-SOL",
      pnlUsd: -1,
      pnlPct: -0.5,
      reason: "Low yield: fee/TVL 0.92% < min 3% (age: 45m)",
      strategy: "bid_ask",
    });
    assert.match(html, /Position Closed/);
    assert.ok(!html.includes("0.92% < min"));
    assert.match(html, /&lt; min/);
  });
});