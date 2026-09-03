import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const appSource = readFileSync(new URL("../src/app.mjs", import.meta.url), "utf8");
const styles = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("uses the new CashLatch brand without the old onboarding badge", () => {
  assert.match(appSource, /Plans change\. Your control doesn’t\./);
  assert.match(appSource, /assets\/cashlatch-logo\.png/);
  assert.match(html, /assets\/cashlatch-logo\.png/);
  assert.doesNotMatch(appSource, /Works with or without ChatGPT/);
});

test("keeps workspace creation reachable from both home and dashboard", () => {
  assert.match(appSource, /data-action="back-to-workspaces"/);
  assert.match(appSource, /data-action="new-workspace">\+ New workspace/);
  assert.match(appSource, /data-action="open-workspace"/);
  assert.ok(appSource.split("${renderNewWorkspaceModal()}").length >= 3);
});

test("provides labelled responsive goal and commitment fields", () => {
  for (const label of [
    "Goal name",
    "Saved so far",
    "Target amount",
    "Target date",
    "Priority",
    "Commitment name",
    "Monthly amount",
    "Due day",
  ]) {
    assert.match(appSource, new RegExp(`>${label}<`));
  }
  assert.match(styles, /\.editable-row,[\s\S]*grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(styles, /\.modal \{[\s\S]*overflow-x: hidden/);
});

test("defines high-contrast dropdown options and a fixed forecast axis", () => {
  assert.match(styles, /select option \{[\s\S]*color: #f5faf7;[\s\S]*background: #12261f/);
  assert.match(appSource, /const axisDays = \[0, 30, 60, 90\]/);
  assert.doesNotMatch(appSource, />\$\{point\.day\}d<\/text>/);
});
