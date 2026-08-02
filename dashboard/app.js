'use strict';

// Talks to DashboardApiFunction's GET /readings|/insights|/battery-status via
// the same CloudFront distribution this page is served from. Two independent
// layers protect those calls: CloudFront injects the API key as a static
// origin header (this file never needs to know it), and API Gateway also
// requires a valid Cognito ID token in the Authorization header — which is
// what the login form below is for. config.json (deployed alongside this
// file, not a secret — Cognito app clients have no client secret) supplies
// the User Pool Client ID and region needed to talk to Cognito directly.

const SESSION_TOKEN_KEY = 'powerplant.idToken';
const SESSION_EXPIRES_KEY = 'powerplant.tokenExpiresAt';

const els = {
  loginSection: document.getElementById('loginSection'),
  loginForm: document.getElementById('loginForm'),
  loginError: document.getElementById('loginError'),
  dashboardRoot: document.getElementById('dashboardRoot'),
  logoutButton: document.getElementById('logoutButton'),
  status: document.getElementById('status'),
  cards: document.getElementById('cards'),
  chartWrap: document.getElementById('chartWrap'),
  meta: document.getElementById('meta'),
  pvYieldKwh: document.getElementById('pvYieldKwh'),
  importKwh: document.getElementById('importKwh'),
  importCost: document.getElementById('importCost'),
  exportKwh: document.getElementById('exportKwh'),
  exportCredit: document.getElementById('exportCredit'),
  netCost: document.getElementById('netCost'),
  batteryStatusPanelSection: document.getElementById('batteryStatusPanelSection'),
  liveBatterySOC: document.getElementById('liveBatterySOC'),
  liveBatteryStatus: document.getElementById('liveBatteryStatus'),
  liveBatteryPower: document.getElementById('liveBatteryPower'),
  liveBatteryTemperature: document.getElementById('liveBatteryTemperature'),
  liveBatteryRemaining: document.getElementById('liveBatteryRemaining'),
  liveBatteryCycles: document.getElementById('liveBatteryCycles'),
  weatherWidget: document.getElementById('weatherWidget'),
  weatherCurrent: document.getElementById('weatherCurrent'),
  weatherClassification: document.getElementById('weatherClassification'),
  weatherReasoning: document.getElementById('weatherReasoning'),
  batteryDecisionWidget: document.getElementById('batteryDecisionWidget'),
  batteryChargeTarget: document.getElementById('batteryChargeTarget'),
  batteryDecisionAppliesTo: document.getElementById('batteryDecisionAppliesTo'),
  batteryDecisionMeta: document.getElementById('batteryDecisionMeta'),
  batteryStatusStatus: document.getElementById('batteryStatusStatus'),
  aiCardSection: document.getElementById('aiCardSection'),
  insightsStatus: document.getElementById('insightsStatus'),
  insightsMeta: document.getElementById('insightsMeta'),
  recommendationBox: document.getElementById('recommendationBox'),
  aiNarrativeBox: document.getElementById('aiNarrativeBox'),
  aiNarrativeText: document.getElementById('aiNarrativeText'),
  anomaliesLabel: document.getElementById('anomaliesLabel'),
  aiAnomaliesList: document.getElementById('aiAnomaliesList'),
  previousAssessmentWidget: document.getElementById('previousAssessmentWidget'),
  previousAssessmentAccurate: document.getElementById('previousAssessmentAccurate'),
  previousAssessmentText: document.getElementById('previousAssessmentText'),
  settingsOptimizationWidget: document.getElementById('settingsOptimizationWidget'),
  settingsOptimizationSummary: document.getElementById('settingsOptimizationSummary'),
  settingsOptimizationMeta: document.getElementById('settingsOptimizationMeta'),
  settingsOptimizationReasoning: document.getElementById('settingsOptimizationReasoning'),
  batterySettingsForm: document.getElementById('batterySettingsForm'),
  batteryControlEnabled: document.getElementById('batteryControlEnabled'),
  batteryControlEnabledSource: document.getElementById('batteryControlEnabledSource'),
  batteryControlLive: document.getElementById('batteryControlLive'),
  batteryControlLiveState: document.getElementById('batteryControlLiveState'),
  batteryControlLiveSource: document.getElementById('batteryControlLiveSource'),
  chargeUpperSocSunny: document.getElementById('chargeUpperSocSunny'),
  chargeUpperSocSunnySource: document.getElementById('chargeUpperSocSunnySource'),
  chargeUpperSocPartlyCloudy: document.getElementById('chargeUpperSocPartlyCloudy'),
  chargeUpperSocPartlyCloudySource: document.getElementById('chargeUpperSocPartlyCloudySource'),
  chargeUpperSocOvercast: document.getElementById('chargeUpperSocOvercast'),
  chargeUpperSocOvercastSource: document.getElementById('chargeUpperSocOvercastSource'),
  disabledChargeUpperSoc: document.getElementById('disabledChargeUpperSoc'),
  disabledChargeUpperSocSource: document.getElementById('disabledChargeUpperSocSource'),
  batterySettingsAutoApplyNote: document.getElementById('batterySettingsAutoApplyNote'),
  batterySettingsStatus: document.getElementById('batterySettingsStatus'),
  batterySettingsSaveButton: document.getElementById('batterySettingsSaveButton'),
  runAssessmentButton: document.getElementById('runAssessmentButton'),
  triggerStatus: document.getElementById('triggerStatus'),
  terminateGridDischargeButton: document.getElementById('terminateGridDischargeButton'),
  gridDischargeStatus: document.getElementById('gridDischargeStatus'),
  gridDischargeSettingsForm: document.getElementById('gridDischargeSettingsForm'),
  gridDischargeEnabled: document.getElementById('gridDischargeEnabled'),
  gridDischargeLive: document.getElementById('gridDischargeLive'),
  gridDischargeLiveState: document.getElementById('gridDischargeLiveState'),
  gridDischargeSettingsStatus: document.getElementById('gridDischargeSettingsStatus'),
  gridDischargeSettingsSaveButton: document.getElementById('gridDischargeSettingsSaveButton'),
  settingsOptimizerSettingsForm: document.getElementById('settingsOptimizerSettingsForm'),
  settingsOptimizerAutoApply: document.getElementById('settingsOptimizerAutoApply'),
  settingsOptimizerAutoApplyState: document.getElementById('settingsOptimizerAutoApplyState'),
  settingsOptimizerSettingsStatus: document.getElementById('settingsOptimizerSettingsStatus'),
  settingsOptimizerSettingsSaveButton: document.getElementById('settingsOptimizerSettingsSaveButton')
};

let chart;
let authClientConfig; // { userPoolClientId, region } — loaded from config.json

// ─── Auth ──────────────────────────────────────────────────────────────────

function getStoredToken() {
  const token = sessionStorage.getItem(SESSION_TOKEN_KEY);
  const expiresAt = Number(sessionStorage.getItem(SESSION_EXPIRES_KEY));
  if (!token || !expiresAt || Date.now() >= expiresAt) return null;
  return token;
}

function storeToken(idToken, expiresInSeconds) {
  sessionStorage.setItem(SESSION_TOKEN_KEY, idToken);
  sessionStorage.setItem(SESSION_EXPIRES_KEY, String(Date.now() + expiresInSeconds * 1000));
}

function clearToken() {
  sessionStorage.removeItem(SESSION_TOKEN_KEY);
  sessionStorage.removeItem(SESSION_EXPIRES_KEY);
}

// No SDK, no refresh-token flow — a plain call to Cognito's public JSON API.
// USER_PASSWORD_AUTH must be enabled on the app client (it is, see
// lib/lambda-functions-stack.js) and the user's password must already be
// permanent (admin-set-user-password --permanent at setup time — see
// README), since this doesn't handle the NEW_PASSWORD_REQUIRED challenge.
async function signIn(username, password) {
  const res = await fetch(`https://cognito-idp.${authClientConfig.region}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: authClientConfig.userPoolClientId,
      AuthParameters: { USERNAME: username, PASSWORD: password }
    })
  });

  const payload = await res.json();

  if (!res.ok) {
    throw new Error(payload.message || payload.__type || `Sign-in failed (${res.status})`);
  }

  if (!payload.AuthenticationResult) {
    throw new Error(
      payload.ChallengeName
        ? `Account needs a one-time setup step (${payload.ChallengeName}) — see README.`
        : 'Sign-in did not return a token.'
    );
  }

  storeToken(payload.AuthenticationResult.IdToken, payload.AuthenticationResult.ExpiresIn);
}

// Attaches the Cognito ID token to every dashboard API call. On a 401/403
// (expired/invalid token), drops back to the login form rather than showing
// a raw error — this app doesn't refresh tokens, so re-entering credentials
// is the expected path once the (1 hour) token expires.
async function authorizedFetch(path, options = {}) {
  const token = getStoredToken();
  const headers = { ...options.headers, ...(token ? { Authorization: token } : {}) };
  const res = await fetch(path, { ...options, headers });

  if (res.status === 401 || res.status === 403) {
    clearToken();
    showLogin('Your session expired — please sign in again.');
    throw new Error('Session expired');
  }

  return res;
}

function showLogin(message) {
  els.dashboardRoot.hidden = true;
  els.loginSection.hidden = false;
  if (message) {
    els.loginError.textContent = message;
    els.loginError.hidden = false;
  }
}

function showDashboard() {
  els.loginSection.hidden = true;
  els.dashboardRoot.hidden = false;
  loadReadings('day');
  loadInsights();
  loadBatteryStatus();
  loadBatterySettings();
  loadGridDischargeSettings();
  loadSettingsOptimization();
  loadSettingsOptimizerSettings();
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  els.loginError.hidden = true;

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    await signIn(username, password);
    els.loginForm.reset();
    showDashboard();
  } catch (err) {
    els.loginError.textContent = err.message;
    els.loginError.hidden = false;
  }
});

els.logoutButton.addEventListener('click', () => {
  clearToken();
  showLogin();
});

// ─── Readings ──────────────────────────────────────────────────────────────

document.querySelectorAll('.range-button').forEach(button => {
  button.addEventListener('click', () => {
    document.querySelectorAll('.range-button').forEach(b => b.setAttribute('aria-pressed', 'false'));
    button.setAttribute('aria-pressed', 'true');
    loadReadings(button.dataset.range);
  });
});

function setStatus(message) {
  els.status.textContent = message;
  els.status.hidden = !message;
}

async function loadReadings(range) {
  setStatus('Loading…');
  els.cards.hidden = true;
  els.chartWrap.hidden = true;
  els.batteryStatusPanelSection.hidden = true;

  try {
    const res = await authorizedFetch(`readings?range=${encodeURIComponent(range)}`);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();

    if (!data.readingCount) {
      setStatus('No readings yet for this range.');
      return;
    }

    render(data);
    setStatus('');
  } catch (err) {
    setStatus(`Couldn't load readings: ${err.message}`);
  }
}

function render(data) {
  const currency = data.currency || 'AUD';

  els.pvYieldKwh.textContent = `${data.pvYieldKwh} kWh`;
  els.importKwh.textContent = `${data.importKwh} kWh`;
  els.importCost.textContent = `${data.importCost} ${currency}`;
  els.exportKwh.textContent = `${data.exportKwh} kWh`;
  els.exportCredit.textContent = `${data.exportCredit} ${currency} credit`;
  els.netCost.textContent = `${data.netCost} ${currency}`;

  renderLiveBatteryStatus(data);

  els.cards.hidden = false;
  els.meta.textContent = `${data.readingCount} readings, ${formatTime(data.from)} – ${formatTime(data.to)}`;

  renderChart(data);
  els.chartWrap.hidden = false;
}

// The instantaneous fields (SOC/status/power/health/cycles/remaining) on the
// /readings response always reflect the latest poll regardless of the day/week
// range toggle — see DashboardApiFunction.batterySummary — so this panel never
// changes when switching ranges, unlike the accumulated kWh cards above it.
function renderLiveBatteryStatus(data) {
  if (typeof data.currentBatterySOC !== 'number') {
    els.batteryStatusPanelSection.hidden = true;
    return;
  }

  els.liveBatterySOC.textContent = `${data.currentBatterySOC}%`;
  els.liveBatteryStatus.textContent = formatBatteryStatusLabel(data.currentBatteryStatus);
  els.liveBatteryPower.textContent = formatBatteryPower(data.currentBatteryStatus, data.currentBatteryPowerW);
  els.liveBatteryTemperature.textContent =
    typeof data.batteryTemperatureC === 'number' ? `${data.batteryTemperatureC}°C` : '–';
  els.liveBatteryRemaining.textContent =
    typeof data.batteryRemainingsKwh === 'number' ? `${data.batteryRemainingsKwh} kWh` : '–';
  els.liveBatteryCycles.textContent =
    typeof data.batteryCycleTimes === 'number' ? `${data.batteryCycleTimes} cycles` : '–';

  els.batteryStatusPanelSection.hidden = false;
}

function formatBatteryStatusLabel(status) {
  if (status === 'charging') return '⬆️ Charging';
  if (status === 'discharging') return '⬇️ Discharging';
  return '⏸️ Idle';
}

function formatBatteryPower(status, watts) {
  if (typeof watts !== 'number' || status === 'idle') return '';
  return `${(Math.abs(watts) / 1000).toFixed(2)} kW`;
}

function renderChart(data) {
  const ctx = document.getElementById('energyChart');
  const labels = ['PV Yield', 'Grid Import', 'Grid Export'];
  const values = [data.pvYieldKwh, data.importKwh, data.exportKwh];

  if (chart) {
    chart.data.datasets[0].data = values;
    chart.update();
    return;
  }

  chart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'kWh',
        data: values,
        backgroundColor: ['#f5a623', '#d0021b', '#4a90d9']
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false, // .chart-wrap sets an explicit height (see styles.css) so the chart fills it predictably at any viewport width, rather than being squeezed/stretched by a fixed aspect ratio
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'kWh' } } }
    }
  });
}

// ─── Insights (nightly recommendation + AI narrative) ──────────────────────

function setInsightsStatus(message) {
  els.insightsStatus.textContent = message;
  els.insightsStatus.hidden = !message;
}

// The AI card is shared by three independent data sources (nightly insights,
// battery accuracy, settings recommendation) — each unhides it as soon as it
// has something to show, rather than any one of them owning the card's
// visibility outright. Idempotent (setting hidden=false twice is harmless),
// and once shown the card is never hidden again, same as the old behavior.
function showAiCard() {
  els.aiCardSection.hidden = false;
}

async function loadInsights() {
  try {
    const res = await authorizedFetch('insights');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();

    if (!data.available) {
      setInsightsStatus('No nightly report yet — check back after tonight’s run.');
      return;
    }

    renderInsights(data);
    setInsightsStatus('');
  } catch (err) {
    setInsightsStatus(`Couldn't load insights: ${err.message}`);
  }
}

function renderInsights(data) {
  els.insightsMeta.textContent =
    `From the ${data.lookbackDays}-day report generated ${formatTime(data.generatedAt)}`;
  els.recommendationBox.textContent = data.recommendation;

  if (data.aiInsights) {
    els.aiNarrativeText.textContent = data.aiInsights.narrative;

    const anomalies = data.aiInsights.anomalies || [];
    els.anomaliesLabel.textContent = anomalies.length ? 'Anomalies flagged:' : 'No anomalies flagged.';
    els.aiAnomaliesList.innerHTML = '';
    for (const anomaly of anomalies) {
      const li = document.createElement('li');
      li.textContent = anomaly;
      els.aiAnomaliesList.appendChild(li);
    }

    els.aiNarrativeBox.hidden = false;
  } else {
    els.aiNarrativeBox.hidden = true;
  }

  showAiCard();
}

// ─── Weather + battery charge decision ──────────────────────────────────────

async function loadBatteryStatus() {
  // The weather widget always stays on the page — it just shows a pending/
  // unavailable state until there's data to report, rather than popping in
  // and out. The other two widgets have nothing meaningful to show until a
  // decision exists, so they stay hidden until then.
  setCurrentWeather(null, 'Loading current weather…');
  setForecastDecision('—', 'Loading tomorrow’s forecast…');
  els.batteryDecisionWidget.hidden = true;
  els.previousAssessmentWidget.hidden = true;

  try {
    const res = await authorizedFetch('battery-status');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    setCurrentWeather(data.currentWeather);

    if (!data.available) {
      setForecastDecision('—', 'No forecast decision yet — check back after tonight’s automated run.');
      setBatteryStatusMessage('No battery control decision yet.');
      return;
    }

    renderBatteryStatus(data);
    setBatteryStatusMessage('');
  } catch (err) {
    setCurrentWeather(null, 'Couldn’t load current weather.');
    setForecastDecision('—', 'Couldn’t load the forecast.');
    setBatteryStatusMessage(`Couldn't load battery status: ${err.message}`);
  }
}

function setBatteryStatusMessage(message) {
  els.batteryStatusStatus.textContent = message;
  els.batteryStatusStatus.hidden = !message;
}

// currentWeather is a live OpenWeatherMap lookup (DashboardApiFunction.fetchCurrentWeather),
// independent of whether BatteryControlFunction has ever run — falls back to
// a plain unavailable message (or the loadingMessage while a request is in
// flight) rather than hiding the widget, same "always present" reasoning as
// loadBatteryStatus above.
function setCurrentWeather(currentWeather, loadingMessage) {
  if (loadingMessage) {
    els.weatherCurrent.textContent = loadingMessage;
    return;
  }

  els.weatherCurrent.textContent = currentWeather && typeof currentWeather.tempC === 'number'
    ? currentWeather.description ? `${currentWeather.tempC}°C, ${currentWeather.description}` : `${currentWeather.tempC}°C`
    : 'Current weather unavailable';
}

function setForecastDecision(classification, reasoning) {
  els.weatherClassification.textContent = classification;
  els.weatherReasoning.textContent = reasoning;
}

function renderBatteryStatus(data) {
  if (!data.enabled) {
    setForecastDecision('—', 'Nightly charge control is currently turned off.');

    els.batteryChargeTarget.textContent = 'Disabled';
    els.batteryDecisionMeta.textContent = `As of ${formatTime(data.decidedAt)}`;
    els.batteryDecisionWidget.hidden = false;
  } else {
    const classificationLabel = data.classification === 'sunny' ? '☀️ Sunny'
      : data.classification === 'partly-cloudy' ? '⛅ Partly cloudy'
      : '☁️ Overcast';
    setForecastDecision(classificationLabel, data.reasoning);

    els.batteryChargeTarget.textContent = `${data.chargeUpperSoc}% charge target`;
    els.batteryDecisionMeta.textContent = data.dryRun
      ? `Dry run — decided ${formatTime(data.decidedAt)}, not applied`
      : `Applied ${formatTime(data.decidedAt)}`;
    els.batteryDecisionWidget.hidden = false;
  }

  els.batteryDecisionAppliesTo.textContent = data.appliesToDate
    ? `Applies from ${formatAppliesToDate(data.appliesToDate)}`
    : '';

  if (data.previousAssessment) {
    els.previousAssessmentAccurate.textContent = data.previousAssessment.accurate ? '✓ On target' : '✗ Off target';
    els.previousAssessmentText.textContent = data.previousAssessment.usageShouldInfluence
      ? `${data.previousAssessment.assessment} ${data.previousAssessment.usageNote}`
      : data.previousAssessment.assessment;
    els.previousAssessmentWidget.hidden = false;
    showAiCard();
  }
}

// SettingsOptimizerFunction's latest nightly recommendation — a separate
// endpoint from battery-status, so a failure here just hides the widget
// rather than displacing the (more important) weather/charge-decision ones.
async function loadSettingsOptimization() {
  try {
    const res = await authorizedFetch('settings-optimization');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    if (!data.available) {
      els.settingsOptimizationWidget.hidden = true;
      return;
    }

    const recommendations = data.recommendations || {};
    const changed = Object.values(recommendations).filter(r => r && r.recommended !== null);

    els.settingsOptimizationSummary.textContent = changed.length
      ? `${changed.length} change${changed.length === 1 ? '' : 's'} recommended`
      : 'No changes recommended';

    const status = data.applied ? 'Applied' : data.autoApply ? 'Not applied' : 'Recommendation only';
    els.settingsOptimizationMeta.textContent = data.confidence
      ? `Confidence: ${data.confidence} · ${status} · ${formatTime(data.assessedAt)}`
      : `${status} · ${formatTime(data.assessedAt)}`;

    els.settingsOptimizationReasoning.textContent = data.reasoning || '';
    els.settingsOptimizationWidget.hidden = false;
    showAiCard();
  } catch {
    els.settingsOptimizationWidget.hidden = true;
  }
}

// ─── Settings optimizer settings ("Full automation" toggle) ────────────────
// The system's one self-directing switch: on, SettingsOptimizerFunction's
// nightly recommendation writes straight into the live control settings with
// no manual step; off (default), it only ever recommends. Same toggle-pill +
// confirm() + unsaved-changes pattern as the battery/grid-discharge control
// mode toggles — arguably the most consequential of the three, since it's the
// one that lets the AI change what the *other* two toggles' settings are.

async function loadSettingsOptimizerSettings() {
  try {
    const res = await authorizedFetch('settings-optimizer-settings');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    els.settingsOptimizerAutoApply.checked = data.autoApply === true;
    updateSettingsOptimizerAutoApplyLabel();
    setSettingsOptimizerSettingsStatus('');
  } catch (err) {
    setSettingsOptimizerSettingsStatus(`Couldn't load settings: ${humanizeSettingsError(err.message, SETTINGS_OPTIMIZER_SETTINGS_FIELD_LABELS)}`);
  }
}

function setSettingsOptimizerSettingsStatus(message) {
  els.settingsOptimizerSettingsStatus.textContent = message;
  els.settingsOptimizerSettingsStatus.hidden = !message;
}

function updateSettingsOptimizerAutoApplyLabel() {
  const isAuto = els.settingsOptimizerAutoApply.checked;
  els.settingsOptimizerAutoApplyState.textContent = isAuto ? 'FULLY AUTOMATED — AI writes live settings' : 'Recommend only';
  els.settingsOptimizerAutoApplyState.classList.toggle('is-live', isAuto);
  applyBatterySettingsLockState(isAuto);
}

// The only fields SettingsOptimizerFunction.applyRecommendations ever writes
// into BATTERY_CONTROL_SETTINGS# — enabled/dryRun are dashboard-only and the
// AI never touches them, so they stay editable regardless of automation state.
const AI_MANAGED_BATTERY_SETTINGS_FIELDS = [
  els.chargeUpperSocSunny,
  els.chargeUpperSocPartlyCloudy,
  els.chargeUpperSocOvercast,
  els.disabledChargeUpperSoc
];

// When Full Automation is on, the nightly optimizer can silently overwrite
// these same fields a human just edited — locking them removes that race
// instead of leaving both writers pointed at the same row. Toggled from
// updateSettingsOptimizerAutoApplyLabel, the single place that already
// reacts to every load/change of the autoApply checkbox.
function applyBatterySettingsLockState(isLocked) {
  AI_MANAGED_BATTERY_SETTINGS_FIELDS.forEach(el => { el.disabled = isLocked; });
  els.batterySettingsAutoApplyNote.hidden = !isLocked;
}

els.settingsOptimizerAutoApply.addEventListener('change', () => {
  if (els.settingsOptimizerAutoApply.checked) {
    const confirmed = window.confirm(
      'Turn on full automation? Every night, the AI\'s settings recommendation will be written straight into the live battery/grid-discharge settings automatically — no manual review or save.'
    );
    if (!confirmed) {
      els.settingsOptimizerAutoApply.checked = false;
    }
  }
  updateSettingsOptimizerAutoApplyLabel();
});

els.settingsOptimizerSettingsForm.addEventListener('input', () => {
  setSaveButtonDirty(els.settingsOptimizerSettingsSaveButton, true);
});

els.settingsOptimizerSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setSettingsOptimizerSettingsStatus('Saving…');

  try {
    const res = await authorizedFetch('settings-optimizer-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoApply: els.settingsOptimizerAutoApply.checked })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Request failed: ${res.status}`);
    }

    setSaveButtonDirty(els.settingsOptimizerSettingsSaveButton, false);
    setSettingsOptimizerSettingsStatus('Saved — takes effect on tonight\'s assessment.');
  } catch (err) {
    setSettingsOptimizerSettingsStatus(`Couldn't save settings: ${humanizeSettingsError(err.message, SETTINGS_OPTIMIZER_SETTINGS_FIELD_LABELS)}`);
  }
});

// ─── Settings error messages (translate API/validation errors to plain English) ──

// Mirrors the row labels shown on each settings panel, so a validation error
// names the same thing the user is looking at rather than a raw config field
// (e.g. "chargeUpperSocPartlyCloudy must be a number between 0 and 100").
const BATTERY_SETTINGS_FIELD_LABELS = {
  enabled: 'Nightly charge control enabled',
  dryRun: 'Control mode',
  chargeUpperSocSunny: 'Sunny forecast charge target',
  chargeUpperSocPartlyCloudy: 'Partly cloudy forecast charge target',
  chargeUpperSocOvercast: 'Overcast/rainy forecast charge target',
  disabledChargeUpperSoc: 'Default charge when disabled'
};

const GRID_DISCHARGE_SETTINGS_FIELD_LABELS = {
  enabled: 'Evening discharge enabled',
  dryRun: 'Control mode'
};

const SETTINGS_OPTIMIZER_SETTINGS_FIELD_LABELS = {
  autoApply: 'Full automation'
};

// Translates DashboardApiFunction's raw validate*/error messages (field
// names, HTTP status codes) into something a non-technical reader can act
// on. Falls back to the original message for anything unrecognized, rather
// than hiding it — this is a small single-user app, not a public product,
// so an unmatched technical message surfacing occasionally is preferable to
// silently swallowing detail that would help track down a real bug.
function humanizeSettingsError(message, fieldLabels) {
  if (!message) return 'Something went wrong — please try again.';

  const percentMatch = message.match(/^(\w+) must be a number between 0 and 100$/);
  if (percentMatch) {
    const label = fieldLabels[percentMatch[1]] || percentMatch[1];
    return `"${label}" must be a percentage between 0 and 100.`;
  }

  const boolMatch = message.match(/^(\w+) must be a boolean$/);
  if (boolMatch) {
    const label = fieldLabels[boolMatch[1]] || boolMatch[1];
    return `There was a problem with the "${label}" toggle — please reload the page and try again.`;
  }

  if (message === 'Request body must be valid JSON') {
    return 'Something went wrong preparing your request — please try again.';
  }

  if (message === 'Internal server error') {
    return 'Something went wrong saving your settings — please try again in a moment.';
  }

  if (/^Request failed: \d+$/.test(message)) {
    return "Couldn't reach the server — please check your connection and try again.";
  }

  return message;
}

// Marks a settings form's Save button as soon as any field changes, so a
// toggle (which only updates on-screen state — it never saves by itself)
// can never be mistaken for something that's already been persisted. Cleared
// only on a successful save; a failed save leaves it marked, since the
// change genuinely is still unsaved. Programmatic population (loadBatterySettings/
// loadGridDischargeSettings setting .value/.checked from the server response)
// doesn't fire input events, so this never triggers from a normal page load.
function setSaveButtonDirty(button, isDirty) {
  button.textContent = isDirty ? 'Save settings (unsaved changes)' : 'Save settings';
  button.classList.toggle('unsaved', isDirty);
}

// Labels a settings field with where its current value actually came from —
// the config default, a human's dashboard save, or SettingsOptimizerFunction's
// weekly AI recommendation — so the two can never be visually indistinguishable
// (a plain number in a text box otherwise looks the same regardless of source).
// A human-set value ('dashboard') gets no badge at all — it's the implicit
// baseline state; only the two states worth calling out are marked.
function renderSourceBadge(el, source) {
  if (source === 'settings-optimizer') {
    el.textContent = 'AI recommended';
    el.className = 'source-badge source-badge--ai';
  } else if (source === 'default') {
    el.textContent = 'default';
    el.className = 'source-badge source-badge--default';
  } else {
    el.textContent = '';
    el.className = 'source-badge';
  }
}

// ─── Battery control settings (edit charge % + on/off toggle) ──────────────

async function loadBatterySettings() {
  try {
    const res = await authorizedFetch('battery-settings');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    els.batteryControlEnabled.checked = data.enabled;
    els.batteryControlLive.checked = data.dryRun === false;
    updateLiveStateLabel();
    els.chargeUpperSocSunny.value = data.chargeUpperSocSunny;
    els.chargeUpperSocPartlyCloudy.value = data.chargeUpperSocPartlyCloudy;
    els.chargeUpperSocOvercast.value = data.chargeUpperSocOvercast;
    els.disabledChargeUpperSoc.value = data.disabledChargeUpperSoc;
    renderSourceBadge(els.batteryControlEnabledSource, data.sources?.enabled);
    renderSourceBadge(els.batteryControlLiveSource, data.sources?.dryRun);
    renderSourceBadge(els.chargeUpperSocSunnySource, data.sources?.chargeUpperSocSunny);
    renderSourceBadge(els.chargeUpperSocPartlyCloudySource, data.sources?.chargeUpperSocPartlyCloudy);
    renderSourceBadge(els.chargeUpperSocOvercastSource, data.sources?.chargeUpperSocOvercast);
    renderSourceBadge(els.disabledChargeUpperSocSource, data.sources?.disabledChargeUpperSoc);
    setBatterySettingsStatus('');
  } catch (err) {
    setBatterySettingsStatus(`Couldn't load settings: ${humanizeSettingsError(err.message, BATTERY_SETTINGS_FIELD_LABELS)}`);
  }
}

function setBatterySettingsStatus(message) {
  els.batterySettingsStatus.textContent = message;
  els.batterySettingsStatus.hidden = !message;
}

function updateLiveStateLabel() {
  const isLive = els.batteryControlLive.checked;
  els.batteryControlLiveState.textContent = isLive ? 'LIVE — will call the inverter' : 'Dry run';
  els.batteryControlLiveState.classList.toggle('is-live', isLive);
}

// Switching to live is the one settings change here that can actually move
// the inverter, so it gets a confirm step rather than silently flipping on
// the same click — same caution as any other "make this actually control
// hardware" action in this app.
els.batteryControlLive.addEventListener('change', () => {
  if (els.batteryControlLive.checked) {
    const confirmed = window.confirm(
      'Switch battery control to LIVE? It will call the real inverter API on its next nightly run, instead of only logging what it would do.'
    );
    if (!confirmed) {
      els.batteryControlLive.checked = false;
    }
  }
  updateLiveStateLabel();
});

// Any field changing — including the toggle-pills above, which only update
// on-screen state and never save by themselves — marks the form unsaved
// immediately, so it's never ambiguous whether what's on screen has actually
// been persisted yet.
els.batterySettingsForm.addEventListener('input', () => {
  setSaveButtonDirty(els.batterySettingsSaveButton, true);
});

els.batterySettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBatterySettingsStatus('Saving…');

  try {
    const res = await authorizedFetch('battery-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: els.batteryControlEnabled.checked,
        dryRun: !els.batteryControlLive.checked,
        chargeUpperSocSunny: Number(els.chargeUpperSocSunny.value),
        chargeUpperSocPartlyCloudy: Number(els.chargeUpperSocPartlyCloudy.value),
        chargeUpperSocOvercast: Number(els.chargeUpperSocOvercast.value),
        disabledChargeUpperSoc: Number(els.disabledChargeUpperSoc.value)
      })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Request failed: ${res.status}`);
    }

    const saved = await res.json();
    renderSourceBadge(els.batteryControlEnabledSource, saved.sources?.enabled);
    renderSourceBadge(els.batteryControlLiveSource, saved.sources?.dryRun);
    renderSourceBadge(els.chargeUpperSocSunnySource, saved.sources?.chargeUpperSocSunny);
    renderSourceBadge(els.chargeUpperSocPartlyCloudySource, saved.sources?.chargeUpperSocPartlyCloudy);
    renderSourceBadge(els.chargeUpperSocOvercastSource, saved.sources?.chargeUpperSocOvercast);
    renderSourceBadge(els.disabledChargeUpperSocSource, saved.sources?.disabledChargeUpperSoc);

    setSaveButtonDirty(els.batterySettingsSaveButton, false);
    setBatterySettingsStatus('Saved — takes effect on the next nightly run.');
  } catch (err) {
    setBatterySettingsStatus(`Couldn't save settings: ${humanizeSettingsError(err.message, BATTERY_SETTINGS_FIELD_LABELS)}`);
  }
});

// ─── Manual assessment trigger ──────────────────────────────────────────────

els.runAssessmentButton.addEventListener('click', async () => {
  els.triggerStatus.hidden = false;
  els.triggerStatus.textContent = 'Starting assessment…';

  try {
    const res = await authorizedFetch('insights', { method: 'POST' });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    els.triggerStatus.textContent = data.message || 'Assessment started — check back shortly.';
  } catch (err) {
    els.triggerStatus.textContent = `Couldn't trigger assessment: ${err.message}`;
  }
});

// ─── Grid discharge control settings (enabled + dry-run/live toggle) ───────

async function loadGridDischargeSettings() {
  try {
    const res = await authorizedFetch('grid-discharge-settings');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    els.gridDischargeEnabled.checked = data.enabled;
    els.gridDischargeLive.checked = data.dryRun === false;
    updateGridDischargeLiveStateLabel();
    setGridDischargeSettingsStatus('');
  } catch (err) {
    setGridDischargeSettingsStatus(`Couldn't load settings: ${humanizeSettingsError(err.message, GRID_DISCHARGE_SETTINGS_FIELD_LABELS)}`);
  }
}

function setGridDischargeSettingsStatus(message) {
  els.gridDischargeSettingsStatus.textContent = message;
  els.gridDischargeSettingsStatus.hidden = !message;
}

function updateGridDischargeLiveStateLabel() {
  const isLive = els.gridDischargeLive.checked;
  els.gridDischargeLiveState.textContent = isLive ? 'LIVE — will call the inverter' : 'Dry run';
  els.gridDischargeLiveState.classList.toggle('is-live', isLive);
}

// Same reasoning as the battery control mode toggle — this can actually
// discharge the battery to the grid, so switching to live gets a confirm
// step rather than flipping on the same click.
els.gridDischargeLive.addEventListener('change', () => {
  if (els.gridDischargeLive.checked) {
    const confirmed = window.confirm(
      'Switch grid discharge to LIVE? It will call the real inverter API on its next start/check/exit phase, instead of only logging what it would do.'
    );
    if (!confirmed) {
      els.gridDischargeLive.checked = false;
    }
  }
  updateGridDischargeLiveStateLabel();
});

// Same reasoning as the battery settings form — the toggle-pills here never
// save by themselves either.
els.gridDischargeSettingsForm.addEventListener('input', () => {
  setSaveButtonDirty(els.gridDischargeSettingsSaveButton, true);
});

els.gridDischargeSettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setGridDischargeSettingsStatus('Saving…');

  try {
    const res = await authorizedFetch('grid-discharge-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: els.gridDischargeEnabled.checked,
        dryRun: !els.gridDischargeLive.checked
      })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Request failed: ${res.status}`);
    }

    setSaveButtonDirty(els.gridDischargeSettingsSaveButton, false);
    setGridDischargeSettingsStatus('Saved — takes effect on the next start/check/exit phase.');
  } catch (err) {
    setGridDischargeSettingsStatus(`Couldn't save settings: ${humanizeSettingsError(err.message, GRID_DISCHARGE_SETTINGS_FIELD_LABELS)}`);
  }
});

// ─── Manual grid discharge termination ─────────────────────────────────────

els.terminateGridDischargeButton.addEventListener('click', async () => {
  els.gridDischargeStatus.hidden = false;
  els.gridDischargeStatus.textContent = 'Requesting…';

  try {
    const res = await authorizedFetch('grid-discharge', { method: 'POST' });
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    els.gridDischargeStatus.textContent = data.message || 'Exit requested.';
  } catch (err) {
    els.gridDischargeStatus.textContent = `Couldn't request exit: ${err.message}`;
  }
});

// ─── Init ────────────────────────────────────────────────────────────────

function formatTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString();
}

// dateStr is a plain "YYYY-MM-DD" calendar date (BatteryControlFunction's
// appliesToDate, computed in the site's local timezone), not a timestamp —
// built via the Date(year, month, day) local-components constructor rather
// than new Date(dateStr), which parses date-only ISO strings as UTC midnight
// and can display as the wrong day once shifted to the viewer's local time.
function formatAppliesToDate(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    weekday: 'short', day: 'numeric', month: 'short'
  });
}

async function init() {
  const res = await fetch('config.json');
  authClientConfig = await res.json();

  if (getStoredToken()) {
    showDashboard();
  } else {
    showLogin();
  }
}

init();
