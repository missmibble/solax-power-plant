'use strict';

// Talks to DashboardApiFunction's GET /readings?range=day|week via the same
// CloudFront distribution this page is served from — the "readings" cache
// behavior forwards to API Gateway with the API key injected as a static
// origin header, so this file never needs to know the key.

const els = {
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
  batteryCard: document.getElementById('batteryCard'),
  batterySOC: document.getElementById('batterySOC'),
  batteryChargeDischarge: document.getElementById('batteryChargeDischarge')
};

let chart;

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

  try {
    const res = await fetch(`readings?range=${encodeURIComponent(range)}`);
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

  if (typeof data.currentBatterySOC === 'number') {
    els.batteryCard.hidden = false;
    els.batterySOC.textContent = `${data.currentBatterySOC}% SOC`;
    els.batteryChargeDischarge.textContent =
      `charged ${data.batteryChargeKwh} kWh / discharged ${data.batteryDischargeKwh} kWh`;
  } else {
    els.batteryCard.hidden = true;
  }

  els.cards.hidden = false;
  els.meta.textContent = `${data.readingCount} readings, ${formatTime(data.from)} – ${formatTime(data.to)}`;

  renderChart(data);
  els.chartWrap.hidden = false;
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
      plugins: { legend: { display: false } },
      scales: { y: { beginAtZero: true, title: { display: true, text: 'kWh' } } }
    }
  });
}

function formatTime(epochSeconds) {
  return new Date(epochSeconds * 1000).toLocaleString();
}

loadReadings('day');
