#!/usr/bin/env node
// AxoReview: copy of scripts/crawl.mjs — source of truth is scripts/, edit there, not here.
// AxoReview crawler: inventories and exercises interactive elements in a RUNNING app.
// Only run against apps you own or are authorized to test (prefer local/staging).
//
// Usage: node crawl.mjs <baseUrl> [--out dir] [--max-pages 50] [--storage state.json]
//                       [--no-click] [--allow-destructive]
// Requires: npm i -D playwright && npx playwright install chromium
//
// Output: <out>/report.json (findings), <out>/inventory.json (pages + elements), <out>/shots/*.png
// Findings are HEURISTIC leads to verify, not proof. "No observable effect" can be a false positive.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const base = args[0];
if (!base || base.startsWith('--')) {
  console.error('usage: node crawl.mjs <baseUrl> [--out dir] [--max-pages N] [--storage file] [--no-click] [--allow-destructive]');
  process.exit(2);
}
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const flag = (n) => args.includes(n);

const out = opt('--out', '.axoreview/crawl');
const maxPages = parseInt(opt('--max-pages', '50'), 10);
const storage = opt('--storage', undefined);
const noClick = flag('--no-click');
const allowDestructive = flag('--allow-destructive');

// Skipped by default so the crawler never deletes data, pays, or logs you out.
const DESTRUCTIVE = /(delete|remove|destroy|deactivate|cancel (subscription|account)|pay\b|purchase|buy\b|checkout|place order|confirm order|sign ?out|log ?out|unsubscribe|wipe|revoke|transfer|erase|reset (data|account))/i;

const origin = new URL(base).origin;
fs.mkdirSync(path.join(out, 'shots'), { recursive: true });

const report = { base, startedAt: new Date().toISOString(), summary: {}, findings: [] };
const inventory = { base, pages: [] };
const add = (severity, type, page, detail) => report.findings.push({ severity, type, page, detail });
const safe = (u) => u.replace(/[^a-z0-9]+/gi, '_').slice(0, 80);

// Tag every interactive element with data-axo so it can be targeted reliably.
async function collect(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };
    const nameOf = (el) =>
      (el.getAttribute('aria-label') || el.innerText || el.value || el.title ||
        el.getAttribute('alt') || el.getAttribute('placeholder') || '').trim().slice(0, 80);
    const sel = 'a[href],button,[role=button],input,select,textarea,summary,[onclick]';
    return [...document.querySelectorAll(sel)].map((el, i) => {
      el.setAttribute('data-axo', String(i));
      const tag = el.tagName.toLowerCase();
      const isField = ['input', 'select', 'textarea'].includes(tag);
      const labelled = !isField || (el.labels && el.labels.length > 0) ||
        el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title');
      return {
        axo: i, tag, type: el.getAttribute('type'), role: el.getAttribute('role'),
        text: nameOf(el), href: el.getAttribute('href'), target: el.getAttribute('target'),
        rel: el.getAttribute('rel'), disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
        visible: visible(el), inForm: !!el.closest('form'), labelled: !!labelled,
      };
    });
  });
}

const browser = await chromium.launch();
const context = await browser.newContext(storage ? { storageState: storage } : {});
const queue = [new URL(base).href];
const seen = new Set();
let clicked = 0, skipped = 0;

while (queue.length && seen.size < maxPages) {
  const url = queue.shift();
  const key = url.split('#')[0];
  if (seen.has(key)) continue;
  seen.add(key);

  const page = await context.newPage();
  const consoleErrors = [];
  const failed = [];
  let dialogs = 0;
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));
  page.on('response', (r) => { if (r.status() >= 400) failed.push({ status: r.status(), method: r.request().method(), url: r.url() }); });
  page.on('requestfailed', (r) => failed.push({ status: 0, method: r.method(), url: r.url(), error: r.failure()?.errorText }));
  page.on('dialog', async (d) => { dialogs++; await d.dismiss().catch(() => {}); });

  try {
    const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const status = resp ? resp.status() : null;
    if (status && status >= 400) add('high', 'http-error', url, `Page returned ${status}`);
  } catch (e) {
    add('high', 'navigation-failed', url, String(e.message).split('\n')[0]);
    await page.close();
    continue;
  }

  await page.screenshot({ path: path.join(out, 'shots', safe(key) + '.png'), fullPage: true }).catch(() => {});
  const elements = await collect(page);
  inventory.pages.push({ url: key, title: await page.title().catch(() => ''), elements });

  // Static checks on the inventory.
  for (const el of elements) {
    if (!el.visible) continue;
    const where = `${el.tag}${el.text ? ` "${el.text}"` : ''}`;
    if (!el.text && !el.labelled) add('minor', 'a11y-unnamed-control', key, `${where} has no accessible name`);
    if (el.tag === 'a' && (el.href === '#' || /^javascript:/i.test(el.href || ''))) add('minor', 'dead-link', key, `${where} href="${el.href}"`);
    if (el.tag === 'a' && el.target === '_blank' && !/noopener/.test(el.rel || '')) add('minor', 'missing-noopener', key, `${where} opens a new tab without rel=noopener`);
    if (el.tag === 'a' && el.href) {
      try {
        const u = new URL(el.href, url);
        if (u.origin === origin && !seen.has(u.href.split('#')[0])) queue.push(u.href);
      } catch { /* ignore malformed hrefs */ }
    }
  }

  // Click-test visible, enabled buttons (not links, which are covered by crawling).
  if (!noClick) {
    const clickable = elements.filter((e) => e.visible && !e.disabled &&
      (e.tag === 'button' || e.role === 'button' || e.tag === 'summary' || (e.tag === 'input' && ['button', 'submit'].includes(e.type))));
    for (const el of clickable) {
      if (!allowDestructive && DESTRUCTIVE.test(el.text)) { skipped++; continue; }
      let reqs = 0;
      const onReq = () => { reqs++; };
      page.on('request', onReq);
      const before = { url: page.url(), len: await page.evaluate(() => document.body.innerHTML.length), dialogs };
      let err = null;
      try {
        await page.click(`[data-axo="${el.axo}"]`, { timeout: 3000 });
        await page.waitForTimeout(600);
      } catch (e) { err = String(e.message).split('\n')[0]; }
      page.off('request', onReq);
      clicked++;
      const after = { url: page.url(), len: await page.evaluate(() => document.body.innerHTML.length).catch(() => before.len) };
      const label = `button "${el.text || '(unnamed)'}"`;
      if (err) add('medium', 'click-failed', key, `${label}: ${err}`);
      else if (after.url === before.url && after.len === before.len && reqs === 0 && dialogs === before.dialogs) {
        add('minor', 'no-observable-effect', key, `${label} produced no URL, DOM, network, or dialog change (verify manually)`);
      }
      if (after.url !== before.url) {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
        await collect(page); // re-tag after navigation
      }
    }
  }

  for (const e of consoleErrors) add('medium', 'console-error', key, e.slice(0, 300));
  for (const f of failed) add(f.status >= 500 || f.status === 0 ? 'high' : 'medium', 'failed-request', key, `${f.status} ${f.method} ${f.url}${f.error ? ' ' + f.error : ''}`);
  await page.close();
}

await browser.close();

const bySeverity = {};
for (const f of report.findings) bySeverity[f.severity] = (bySeverity[f.severity] || 0) + 1;
report.finishedAt = new Date().toISOString();
report.summary = {
  pages: inventory.pages.length,
  elements: inventory.pages.reduce((n, p) => n + p.elements.length, 0),
  clicked, skippedDestructive: skipped, findings: report.findings.length, bySeverity,
  note: 'Heuristic results. Confirm each finding with a test before marking FAIL; absence of findings is not proof of correctness.',
};
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
fs.writeFileSync(path.join(out, 'inventory.json'), JSON.stringify(inventory, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
