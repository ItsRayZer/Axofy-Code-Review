// public/landing.js — landing-page behaviour only (hero, nav, install dialog,
// sample demo, result view toggle). The review tool itself lives in app.js.
'use strict';

const $l = (id) => document.getElementById(id);

function gotoTool(tab) {
  const app = $l('app');
  if (app) app.scrollIntoView({ behavior: 'smooth' });
  if (tab) {
    const btn = document.querySelector(`.tab[data-tab="${tab}"]`);
    if (btn) btn.click();
  }
  if (tab === 'review') {
    const input = $l('prUrl');
    if (input) setTimeout(() => input.focus({ preventScroll: true }), 500);
  }
}

// Nav links that jump to a tool tab.
document.querySelectorAll('[data-goto-tab]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    gotoTool(a.dataset.gotoTab);
  });
});

// Hero form: PR URL -> tool input -> run the review.
const heroForm = $l('heroForm');
if (heroForm) {
  heroForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $l('heroPrUrl').value.trim();
    const input = $l('prUrl');
    if (url && input) input.value = url;
    gotoTool('review');
    if (url) setTimeout(() => $l('runReview').click(), 600);
  });
}

// Install dialog.
const dialog = $l('installDialog');
document.querySelectorAll('[data-install-open]').forEach((b) => {
  b.addEventListener('click', () => { if (dialog && dialog.showModal) dialog.showModal(); });
});
document.querySelectorAll('[data-close-install]').forEach((b) => {
  b.addEventListener('click', () => { if (dialog) dialog.close(); });
});
if (dialog) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// Demo: run the same fixture diff live in the tool.
const runSample = $l('runSampleLive');
if (runSample) {
  runSample.addEventListener('click', async () => {
    gotoTool('review');
    try {
      const res = await fetch('/sample.diff');
      const diff = res.ok ? await res.text() : '';
      $l('diffInput').value = diff;
      $l('prUrl').value = '';
      setTimeout(() => $l('runReview').click(), 600);
    } catch {
      $l('reviewStatus').textContent = 'Could not load the sample — paste a diff manually.';
      $l('reviewStatus').classList.add('err');
    }
  });
}

// Result view toggle + inline-comment Resolve (results are injected dynamically,
// so this is delegated on the document).
document.addEventListener('click', (e) => {
  const viewBtn = e.target.closest('[data-result-view]');
  if (viewBtn) {
    const root = viewBtn.closest('#reviewResult');
    if (!root) return;
    root.querySelectorAll('[data-result-view]').forEach((b) => b.classList.toggle('active', b === viewBtn));
    root.querySelectorAll('[data-view-panel]').forEach((p) => { p.hidden = p.dataset.viewPanel !== viewBtn.dataset.resultView; });
    return;
  }
  const resolveBtn = e.target.closest('[data-resolve]');
  if (resolveBtn) {
    const comment = resolveBtn.closest('.gh-comment');
    if (!comment) return;
    const resolved = comment.classList.toggle('resolved');
    resolveBtn.textContent = resolved ? 'Resolved' : 'Resolve';
    resolveBtn.disabled = resolved;
  }
});

// ---- Nav dropdowns (click to toggle, click outside / Esc to close) ----
document.querySelectorAll('[data-drop]').forEach((wrap) => {
  const btn = wrap.querySelector('button');
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const wasOpen = wrap.classList.contains('open');
    document.querySelectorAll('[data-drop].open').forEach((w) => w.classList.remove('open'));
    if (!wasOpen) wrap.classList.add('open');
  });
});
document.addEventListener('click', () => document.querySelectorAll('[data-drop].open').forEach((w) => w.classList.remove('open')));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') document.querySelectorAll('[data-drop].open').forEach((w) => w.classList.remove('open')); });

// ---- Hero carousel: 4 tabs, auto-rotate ~60s, Pause/Resume, progress ----
const HERO_COPY = [
  { eyebrow: 'AGENTIC CHANGE MANAGEMENT — FREE', h: 'The future isn\'t writing code.<br><span class="accent">It\'s reviewing it.</span>', sub: 'Axofy Code Review reads every pull request the way a senior reviewer would: it traces what the change actually touches, checks it against your guidelines and linked issues, and posts a plain-language summary with inline comments you can apply in one click. Every feature included. $0. No seat billing, no card, no file cap.' },
  { eyebrow: 'TRIAGE — FREE', h: 'The future isn\'t writing code.<br><span class="accent">It\'s prioritizing it.</span>', sub: 'A prioritised queue of open PRs across your repos, ordered by risk and effort. A small docs fix never jumps ahead of a security change again.' },
  { eyebrow: 'EXPLAIN — FREE', h: 'The future isn\'t writing code.<br><span class="accent">It\'s understanding it.</span>', sub: 'Change Stack groups files by module, shows moved code, traces blast radius, and draws the architecture impact — so a 2,000-line PR reads in layers, not as one wall of diff.' },
  { eyebrow: 'SECURE — FREE', h: 'The future isn\'t writing code.<br><span class="accent">It\'s securing it.</span>', sub: 'Secrets, injection, dependency and infrastructure checks on every PR, plus whole-repo Deep Scan. Quality gates fail the check run when a critical finding is present.' },
];
const carTrack = $l('carTrack');
const carTabs = Array.from(document.querySelectorAll('.car-tab'));
const carProgs = Array.from(document.querySelectorAll('[data-prog]'));
const carPauseBtn = $l('carPause');
let carIdx = 0, carPaused = false, carTimer = null;
function showCar(i) {
  carIdx = i;
  if (carTrack) carTrack.style.transform = 'translateX(-' + (i * 100) + '%)';
  carTabs.forEach((t, j) => t.classList.toggle('active', j === i));
  carProgs.forEach((p, j) => { p.classList.toggle('fill', j === i && !carPaused); });
  const c = HERO_COPY[i];
  if (c) {
    const eb = $l('heroEyebrow'), hh = $l('heroHeadline'), hs = $l('heroSub');
    if (eb) eb.textContent = c.eyebrow;
    if (hh) hh.innerHTML = c.h;
    if (hs) hs.textContent = c.sub;
  }
}
function carNext() { if (!carPaused) showCar((carIdx + 1) % 4); }
function carStart() { clearInterval(carTimer); carTimer = setInterval(carNext, 60000); }
carTabs.forEach((t) => t.addEventListener('click', () => { showCar(Number(t.dataset.car)); carStart(); }));
if (carPauseBtn) {
  carPauseBtn.addEventListener('click', () => {
    carPaused = !carPaused;
    carPauseBtn.textContent = carPaused ? 'Resume' : 'Pause';
    carProgs.forEach((p, j) => p.classList.toggle('fill', j === carIdx && !carPaused));
  });
}
showCar(0); carStart();

// ---- Codegraph tabs ----
document.querySelectorAll('[data-cg]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-cg]').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('[data-cg-panel]').forEach((p) => p.classList.toggle('active', p.dataset.cgPanel === b.dataset.cg));
  });
});

// ---- Pricing Annual/Monthly toggle (CodeRabbit prices switch, ours stays $0) ----
const CR_PRICES = { annual: { essentials: '$24', team: '$48', advanced: '$72', note: 'annual billing' }, monthly: { essentials: '$30', team: '$60', advanced: '$90', note: 'monthly billing' } };
document.querySelectorAll('[data-bill]').forEach((b) => {
  b.addEventListener('click', () => {
    document.querySelectorAll('[data-bill]').forEach((x) => x.classList.toggle('active', x === b));
    const p = CR_PRICES[b.dataset.bill];
    document.querySelectorAll('[data-cr]').forEach((el) => { el.textContent = p[el.dataset.cr]; });
    const note = document.querySelector('[data-cr-note]');
    if (note) note.textContent = p.note;
    const bn = document.querySelector('[data-bill-note]');
    if (bn) bn.textContent = b.dataset.bill === 'annual' ? 'annual or monthly, it is still $0' : 'monthly billing, still $0';
  });
});

// ---- Login buttons: honest — OAuth not live yet, open install guide ----
document.querySelectorAll('[data-login-provider]').forEach((b) => {
  b.addEventListener('click', () => {
    const note = $l('loginNote');
    if (note) note.textContent = b.dataset.loginProvider + ' login is not live yet — OAuth is coming soon. For now, review without an account below, or install the GitHub App from the guide.';
  });
});

// ---- Newsletter: no mailing list yet, honest local-only note ----
const nlForm = $l('newsletterForm');
if (nlForm) {
  nlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const note = $l('newsletterNote');
    if (note) note.textContent = 'Thanks — there is no mailing list yet, so nothing was sent. Your address was not stored anywhere.';
    nlForm.reset();
  });
}
