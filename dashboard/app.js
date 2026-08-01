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
  insightsSection: document.getElementById('insightsSection'),
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
  batterySettingsForm: document.getElementById('batterySettingsForm'),
  batteryControlEnabled: document.getElementById('batteryControlEnabled'),
  chargeUpperSocSunny: document.getElementById('chargeUpperSocSunny'),
  chargeUpperSocOvercast: document.getElementById('chargeUpperSocOvercast'),
  disabledChargeUpperSoc: document.getElementById('disabledChargeUpperSoc'),
  batterySettingsStatus: document.getElementById('batterySettingsStatus'),
  runAssessmentButton: document.getElementById('runAssessmentButton'),
  triggerStatus: document.getElementById('triggerStatus'),
  terminateGridDischargeButton: document.getElementById('terminateGridDischargeButton'),
  gridDischargeStatus: document.getElementById('gridDischargeStatus')
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

async function loadInsights() {
  els.insightsSection.hidden = true;

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

  els.insightsSection.hidden = false;
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
    setForecastDecision(
      data.classification === 'sunny' ? '☀️ Sunny' : '☁️ Overcast/uncertain',
      data.reasoning
    );

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
  }
}

// ─── Battery control settings (edit charge % + on/off toggle) ──────────────

async function loadBatterySettings() {
  try {
    const res = await authorizedFetch('battery-settings');
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);

    const data = await res.json();
    els.batteryControlEnabled.checked = data.enabled;
    els.chargeUpperSocSunny.value = data.chargeUpperSocSunny;
    els.chargeUpperSocOvercast.value = data.chargeUpperSocOvercast;
    els.disabledChargeUpperSoc.value = data.disabledChargeUpperSoc;
    setBatterySettingsStatus('');
  } catch (err) {
    setBatterySettingsStatus(`Couldn't load settings: ${err.message}`);
  }
}

function setBatterySettingsStatus(message) {
  els.batterySettingsStatus.textContent = message;
  els.batterySettingsStatus.hidden = !message;
}

els.batterySettingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  setBatterySettingsStatus('Saving…');

  try {
    const res = await authorizedFetch('battery-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enabled: els.batteryControlEnabled.checked,
        chargeUpperSocSunny: Number(els.chargeUpperSocSunny.value),
        chargeUpperSocOvercast: Number(els.chargeUpperSocOvercast.value),
        disabledChargeUpperSoc: Number(els.disabledChargeUpperSoc.value)
      })
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || `Request failed: ${res.status}`);
    }

    setBatterySettingsStatus('Saved — takes effect on the next nightly run.');
  } catch (err) {
    setBatterySettingsStatus(`Couldn't save settings: ${err.message}`);
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
