// app.js
// Runs in the browser. It reads the form, asks the backend to do the work, and shows the results.

const POLL_EVERY_MS = 5000; // Ask for the status every 5 seconds...
const MAX_POLLS = 24; // ...up to 24 times, which is 2 minutes.
const FAILED_DASHBOARD_URL = 'https://my.blotato.com/failed';
const STOP_POLLING_STATUSES = [401, 403, 404]; // Trying again would not help with these.

const page = {
  caption: document.getElementById('caption'),
  mediaUrl: document.getElementById('media-url'),
  platforms: document.getElementById('platforms'),
  scenarioBox: document.getElementById('scenario-box'),
  scenario: document.getElementById('scenario'),
  runPreflight: document.getElementById('run-preflight'),
  resultsEmpty: document.getElementById('results-empty'),
  summary: document.getElementById('summary'),
  results: document.getElementById('results'),
  accountsBox: document.getElementById('accounts-box'),
  accounts: document.getElementById('accounts'),
  confirmBox: document.getElementById('confirm-box'),
  confirmPublish: document.getElementById('confirm-publish'),
  confirmText: document.getElementById('confirm-text'),
  send: document.getElementById('send'),
  sendHint: document.getElementById('send-hint'),
  statusEmpty: document.getElementById('status-empty'),
  status: document.getElementById('status'),
};

const DEFAULT_SEND_HINT = 'This button turns on when no check has failed.';

let platformLabels = {};
let mockMode = true;
let busy = false; // True while checking or sending.
let preflightToken = null; // Proof from the backend that this exact post passed.

// Small helper: creates an element with some text. Using textContent means a
// strange link or error message can never run as code on this page.
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function link(url) {
  const anchor = element('a', '', url);
  if (/^https?:\/\//i.test(url)) {
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
  }
  return anchor;
}

async function requestJson(url, options) {
  const response = await fetch(url, options);
  return { ok: response.ok, data: await response.json() };
}

function postJson(url, body) {
  return requestJson(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function readForm() {
  return {
    caption: page.caption.value,
    mediaUrl: page.mediaUrl.value,
    platforms: [...page.platforms.querySelectorAll('input:checked')].map((box) => box.value),
    mockScenario: page.scenario.value,
  };
}

async function loadConfig() {
  const { data: config } = await requestJson('/api/health');
  mockMode = config.mock;

  document.getElementById(config.mock ? 'mock-banner' : 'real-banner').hidden = false;
  page.scenarioBox.hidden = !config.mock;
  config.scenarios.forEach((scenario, index) => {
    const option = element('option', '', `${index + 1}. ${scenario.label}`);
    option.value = scenario.id;
    page.scenario.append(option);
  });

  config.platforms.forEach((platform) => {
    platformLabels[platform.id] = platform.label;
    const label = element('label');
    const box = element('input');
    box.type = 'checkbox';
    box.value = platform.id;
    label.append(box, ` ${platform.label}`);
    page.platforms.append(label);
  });
}

// The form can't be changed while checking or sending, so results always match what's on screen.
function setBusy(isBusy) {
  busy = isBusy;
  page.caption.disabled = isBusy;
  page.mediaUrl.disabled = isBusy;
  page.scenario.disabled = isBusy;
  page.confirmPublish.disabled = isBusy;
  page.platforms.querySelectorAll('input').forEach((box) => { box.disabled = isBusy; });
  page.accounts.querySelectorAll('select').forEach((select) => { select.disabled = isBusy; });
  page.runPreflight.disabled = isBusy;
  updateSendButton();
}

function updateSendButton() {
  const confirmed = mockMode || page.confirmPublish.checked;
  page.send.disabled = busy || !preflightToken || !confirmed;
  // In real mode the hint follows the tick box, so it never says to tick a box that is already ticked.
  if (!mockMode && preflightToken && !busy) {
    page.sendHint.textContent = confirmed ? 'Ready. Pressing Send publishes for real.' : 'Tick the box above to turn on publishing.';
  }
}

// If the post changes, the old results no longer apply, so Send must turn off again.
function resetResults() {
  preflightToken = null;
  page.results.replaceChildren();
  page.resultsEmpty.hidden = false;
  page.summary.hidden = true;
  page.accountsBox.hidden = true;
  page.accounts.replaceChildren();
  page.confirmBox.hidden = true;
  page.confirmPublish.checked = false;
  page.sendHint.textContent = DEFAULT_SEND_HINT;
  updateSendButton();
}

const MARKS = { pass: '✓ Pass', fail: '✕ Fail', skipped: '– Skipped' };

function showChecks(checks) {
  page.resultsEmpty.hidden = true;
  page.results.replaceChildren(
    ...checks.map((check) => {
      const row = element('li', `result-${check.status}`);
      const text = element('div', 'check-text');
      text.append(element('div', 'check-name', check.name), element('div', 'check-reason', check.reason));
      row.append(element('span', `mark mark-${check.status}`, MARKS[check.status]), text);
      return row;
    })
  );
}

// The headline: what passed, failed and was skipped, and whether the post can go out.
function showSummary(checks, allPassed) {
  const count = (status) => checks.filter((check) => check.status === status).length;
  const failed = checks.filter((check) => check.status === 'fail');
  const skipped = count('skipped');

  const heading = allPassed
    ? (skipped ? 'Ready to send, with checks skipped' : 'Ready to send')
    : `Publishing is blocked: fix ${failed.length} ${failed.length === 1 ? 'problem' : 'problems'}`;
  page.summary.className = `summary ${allPassed ? (skipped ? 'summary-warning' : 'summary-ready') : 'summary-blocked'}`;
  page.summary.replaceChildren(
    element('div', 'summary-title', heading),
    element('div', 'summary-counts', `${count('pass')} passed, ${failed.length} failed, ${skipped} skipped`)
  );
  if (!allPassed) {
    const list = element('ul', 'summary-list');
    failed.forEach((check) => list.append(element('li', '', check.name)));
    page.summary.append(list);
  }
  page.summary.hidden = false;
}

// Shows who each post will go out as, with a choice when a platform has several accounts.
function showAccounts(accounts) {
  page.accounts.replaceChildren(
    ...Object.entries(accounts).map(([platform, options]) => {
      const row = element('label', 'account-row');
      const select = element('select');
      select.dataset.platform = platform;
      options.forEach((account) => {
        const option = element('option', '', `${account.username} (${account.fullname})`);
        option.value = account.id;
        select.append(option);
      });
      select.addEventListener('change', updateConfirmText);
      row.append(element('span', 'account-label', platformLabels[platform]), select);
      return row;
    })
  );
  page.accountsBox.hidden = false;
}

function chosenAccounts() {
  return [...page.accounts.querySelectorAll('select')].map((select) => ({
    platform: select.dataset.platform,
    id: select.value,
    name: select.selectedOptions[0].textContent,
  }));
}

function updateConfirmText() {
  const targets = chosenAccounts().map((account) => `${platformLabels[account.platform]}: ${account.name}`).join(', ');
  page.confirmText.textContent = `I understand this publishes a real post to ${targets}. It can't be undone from this app.`;
}

async function runPreflight() {
  resetResults();
  setBusy(true);
  page.runPreflight.textContent = 'Checking...';
  page.resultsEmpty.textContent = 'Checking your link and downloading the file. This can take up to a minute.';
  try {
    const { ok, data } = await postJson('/api/preflight', readForm());
    if (!ok) throw new Error(data.message);
    showChecks(data.checks);
    showSummary(data.checks, data.allPassed);
    if (data.allPassed) {
      preflightToken = data.preflightToken;
      showAccounts(data.accounts);
      if (!mockMode) {
        updateConfirmText();
        page.confirmBox.hidden = false;
        page.sendHint.textContent = 'Tick the box above to turn on publishing.';
      } else {
        page.sendHint.textContent = 'Ready. Press Send to Blotato. Mock mode posts nothing for real.';
      }
    } else {
      page.sendHint.textContent = 'Send stays off until the failed checks are fixed. Fix them, then run Preflight again.';
    }
  } catch (error) {
    const checks = [{ name: 'Preflight could not run', status: 'fail', reason: error.message }];
    showChecks(checks);
    showSummary(checks, false);
  } finally {
    page.resultsEmpty.textContent = 'Run Preflight to see the results here.';
    page.runPreflight.textContent = 'Run Preflight';
    setBusy(false);
  }
}

// Draws one platform's status box. "details" is a list of text lines or elements.
function renderStatus(box, platform, stateClass, title, details = []) {
  box.className = `status-item ${stateClass}`;
  // Display only: the platform name and the status are separate pieces so the status can be shown as a badge.
  const heading = element('div', 'status-title');
  heading.append(element('span', 'status-platform', platformLabels[platform]), element('span', 'status-badge', title));
  box.replaceChildren(heading, ...details);
}

function detailLine(...parts) {
  const line = element('p', 'status-detail');
  line.append(...parts);
  return line;
}

function showFailure(box, platform, explanation) {
  renderStatus(box, platform, 'failed', '✕ Failed', [
    detailLine(element('strong', '', 'What it means: '), explanation.meaning),
    detailLine(element('strong', '', 'How to fix it: '), explanation.fix),
    // "Error message" rather than "Blotato's message", because some errors come from this app itself.
    ...(explanation.known ? [element('p', 'status-detail status-raw', `Error message: ${explanation.rawMessage}`)] : [detailLine(link(FAILED_DASHBOARD_URL))]),
  ]);
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Follows one post until it finishes or we run out of tries.
async function followPost(box, platform, postSubmissionId, account) {
  const accountNote = account ? `Posting as ${account}. ` : '';

  for (let attempt = 1; attempt <= MAX_POLLS; attempt += 1) {
    renderStatus(box, platform, 'in-progress', 'In progress', [detailLine(`${accountNote}Status check ${attempt} of ${MAX_POLLS} comes next.`)]);
    await wait(POLL_EVERY_MS);

    let status;
    try {
      ({ data: status } = await requestJson(`/api/status/${encodeURIComponent(postSubmissionId)}`));
    } catch {
      continue; // A brief connection problem: try again on the next round.
    }

    if (status.lookupFailed) {
      if (STOP_POLLING_STATUSES.includes(status.httpStatus)) return showFailure(box, platform, status.explanation);
      continue; // Rate limits and server hiccups can pass, so keep trying.
    }
    if (status.status === 'published') {
      return renderStatus(box, platform, 'published', '✓ Published', [detailLine('Post link: ', link(status.publicUrl || ''))]);
    }
    if (status.status === 'scheduled') {
      return renderStatus(box, platform, 'scheduled', '✓ Scheduled', [detailLine(`Scheduled for ${status.scheduledTime || 'a later time'}.`)]);
    }
    if (status.status === 'failed') return showFailure(box, platform, status.explanation);
  }

  renderStatus(box, platform, 'timed-out', '⚠ Timed out', [detailLine('Timed out, check the Blotato Failed dashboard at ', link(FAILED_DASHBOARD_URL))]);
}

async function sendPost() {
  const form = readForm();
  const token = preflightToken;
  const accountIds = Object.fromEntries(chosenAccounts().map((account) => [account.platform, account.id]));
  const confirmPublish = page.confirmPublish.checked;

  preflightToken = null; // Each pass works once, so one click can't post the same thing twice.
  setBusy(true);
  page.send.textContent = 'Sending...';
  page.sendHint.textContent = 'Sending. Keep this page open until every platform shows a final result below.';
  page.statusEmpty.hidden = true;
  page.status.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  const boxes = {};
  page.status.replaceChildren(
    ...form.platforms.map((platform) => {
      boxes[platform] = element('div');
      renderStatus(boxes[platform], platform, 'sending', 'Sending');
      return boxes[platform];
    })
  );

  try {
    const { ok, data } = await postJson('/api/send', { ...form, preflightToken: token, confirmPublish, accountIds });
    if (!ok) throw new Error(data.message);

    await Promise.all(
      data.results.map((result) => {
        const box = boxes[result.platform];
        if (result.state === 'failed') return showFailure(box, result.platform, result.explanation);
        return followPost(box, result.platform, result.postSubmissionId, result.account);
      })
    );
  } catch (error) {
    form.platforms.forEach((platform) => {
      showFailure(boxes[platform], platform, {
        known: false,
        meaning: `The app could not finish sending: ${error.message}`,
        fix: `Check the terminal window for details, then open ${FAILED_DASHBOARD_URL} to see if the post arrived.`,
      });
    });
  } finally {
    page.send.textContent = 'Send to Blotato';
    page.confirmPublish.checked = false;
    page.sendHint.textContent = 'Finished. Run Preflight again before sending another post.';
    setBusy(false);
  }
}

page.runPreflight.addEventListener('click', runPreflight);
page.send.addEventListener('click', sendPost);
page.confirmPublish.addEventListener('change', updateSendButton);
page.caption.addEventListener('input', resetResults);
page.mediaUrl.addEventListener('input', resetResults);
page.platforms.addEventListener('change', resetResults);

loadConfig().catch((error) => {
  page.resultsEmpty.textContent = `The page could not load its settings: ${error.message}`;
});
