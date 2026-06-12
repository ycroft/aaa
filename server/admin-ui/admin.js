const $ = (id) => document.getElementById(id);
const tokenInput = $('token');
tokenInput.value = localStorage.token || '';
tokenInput.addEventListener('change', () => { localStorage.token = tokenInput.value; });

function authHeaders() {
  return { 'Authorization': 'Bearer ' + (localStorage.token || '') };
}

async function loadFeedback() {
  const status = $('filter').value;
  const url = status ? '/admin/api/feedback?status=' + encodeURIComponent(status) : '/admin/api/feedback';
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) { alert('请求失败: ' + res.status); return; }
  const j = await res.json();
  const tbody = $('fb-table').querySelector('tbody');
  tbody.innerHTML = '';
  for (const it of j.items) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${new Date(it.created_at).toLocaleString()}</td>
      <td class="status-${it.status}">${it.status}</td>
      <td>${it.category}${it.severity ? '/' + it.severity : ''}</td>
      <td>${escapeHtml(it.title)}</td>
      <td>${escapeHtml(it.app_version)}</td>
      <td>${escapeHtml(it.os_info)}</td>
      <td><button data-id="${it.id}">详情</button></td>`;
    tr.querySelector('button').addEventListener('click', () => openDetail(it));
    tbody.appendChild(tr);
  }
}

function openDetail(it) {
  const note = prompt('admin_note', it.admin_note || '');
  if (note === null) return;
  const status = prompt('status (new|triaged|in_progress|resolved|wontfix)', it.status);
  if (status === null) return;
  fetch('/admin/api/feedback/' + it.id, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ status, admin_note: note }),
  }).then(r => r.ok ? loadFeedback() : alert('更新失败: ' + r.status));
}

function escapeHtml(s) {
  return (s || '').toString().replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

$('reload').addEventListener('click', loadFeedback);
$('filter').addEventListener('change', loadFeedback);
$('tab-fb').addEventListener('click', () => {
  $('view-fb').hidden = false;
  $('view-rel').hidden = true;
  $('tab-fb').classList.add('active');
  $('tab-rel').classList.remove('active');
});
$('tab-rel').addEventListener('click', () => {
  $('view-fb').hidden = true;
  $('view-rel').hidden = false;
  $('tab-rel').classList.add('active');
  $('tab-fb').classList.remove('active');
});

$('rel-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const res = await fetch('/admin/api/releases', { method: 'POST', headers: authHeaders(), body: fd });
  $('rel-out').textContent = res.ok ? 'OK · ' + (await res.text()) : 'FAIL ' + res.status;
});

loadFeedback();
