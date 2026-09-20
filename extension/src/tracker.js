/**
 * The application tracker: every form the extension filled, and where each
 * one got to. The panel writes a row when it fills a form and marks it applied
 * when the person says so; everything after that is theirs to change here.
 */
const STATUSES = ['filled', 'applied', 'interview', 'offer', 'rejected', 'withdrawn'];
const NAMES = { filled: 'Filled, not sent', applied: 'Applied', interview: 'Interviewing', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn' };

let rows = [];
let filter = 'all';

async function loadRows() {
  ({ applications: rows = [] } = await chrome.storage.local.get('applications'));
}

async function persist() {
  await chrome.storage.local.set({ applications: rows });
}

const day = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '');

function filters() {
  const box = document.getElementById('filters');
  box.replaceChildren();
  const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
  for (const key of ['all', ...STATUSES]) {
    const n = key === 'all' ? rows.length : counts[key];
    if (key !== 'all' && !n) continue;
    const b = document.createElement('button');
    b.className = `pill${filter === key ? ' on' : ''}`;
    b.textContent = `${key === 'all' ? 'All' : NAMES[key]} (${n})`;
    b.onclick = () => {
      filter = key;
      draw();
    };
    box.append(b);
  }
}

function cellInput(row, key) {
  const input = document.createElement('input');
  input.value = row[key] || '';
  input.onchange = async () => {
    row[key] = input.value.trim();
    await persist();
  };
  return input;
}

function draw() {
  filters();
  const q = document.getElementById('q').value.trim().toLowerCase();
  const shown = rows.filter((r) => (filter === 'all' || r.status === filter)
    && (!q || `${r.company} ${r.title}`.toLowerCase().includes(q)));
  const list = document.getElementById('list');
  if (!rows.length) {
    list.innerHTML = '<div class="empty">Nothing yet. Open a job application and press the extension button — it is logged here.</div>';
    return;
  }
  const table = document.createElement('table');
  table.innerHTML = '<thead><tr><th>Company</th><th>Role</th><th>Status</th><th class="when">Filled</th><th class="when">Applied</th><th>Notes</th><th></th></tr></thead>';
  const tbody = document.createElement('tbody');
  for (const row of shown) {
    const tr = document.createElement('tr');
    const company = document.createElement('td');
    company.append(cellInput(row, 'company'));
    const title = document.createElement('td');
    title.append(cellInput(row, 'title'));
    const link = document.createElement('a');
    link.href = row.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'open form';
    link.style.fontSize = '12px';
    title.append(link);

    const status = document.createElement('td');
    const select = document.createElement('select');
    for (const s of STATUSES) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = NAMES[s];
      select.append(o);
    }
    select.value = row.status || 'filled';
    select.onchange = async () => {
      row.status = select.value;
      if (row.status === 'applied' && !row.appliedAt) row.appliedAt = new Date().toISOString();
      await persist();
      draw();
    };
    status.append(select);

    const filled = document.createElement('td');
    filled.className = 'when';
    filled.textContent = day(row.filledAt);
    const applied = document.createElement('td');
    applied.className = 'when';
    applied.textContent = day(row.appliedAt);
    const notes = document.createElement('td');
    notes.append(cellInput(row, 'notes'));
    const del = document.createElement('td');
    const x = document.createElement('button');
    x.className = 'del';
    x.title = 'Remove from the tracker';
    x.textContent = '✕';
    x.onclick = async () => {
      if (!confirm(`Remove ${row.company || 'this application'} from the tracker?`)) return;
      rows = rows.filter((r) => r !== row);
      await persist();
      draw();
    };
    del.append(x);
    tr.append(company, title, status, filled, applied, notes, del);
    tbody.append(tr);
  }
  table.append(tbody);
  list.replaceChildren(table);
}

function csv() {
  const head = ['company', 'title', 'status', 'filledAt', 'appliedAt', 'url', 'notes'];
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const body = rows.map((r) => head.map((k) => quote(r[k])).join(','));
  const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `applications-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('q').oninput = draw;
document.getElementById('csv').onclick = csv;
// The panel on another tab may add a row while this page is open.
chrome.storage.onChanged.addListener(async (changes) => {
  if (changes.applications) {
    await loadRows();
    draw();
  }
});

await loadRows();
draw();
