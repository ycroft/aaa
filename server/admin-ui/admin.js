const $ = (id) => document.getElementById(id);
const tokenInput = $('token');
tokenInput.value = localStorage.token || '';
tokenInput.addEventListener('change', () => { localStorage.token = tokenInput.value; loadFeedback(); });

function authHeaders() {
  return { 'Authorization': 'Bearer ' + (localStorage.token || '') };
}

function renderPlaceholder(msg, colspan) {
  const tbody = $('fb-table').querySelector('tbody');
  tbody.innerHTML = `<tr><td colspan="${colspan}" style="color:#888;padding:16px;text-align:center">${escapeHtml(msg)}</td></tr>`;
}

async function loadFeedback() {
  const colspan = 7;
  if (!tokenInput.value) {
    renderPlaceholder('请在右上角输入 admin token 后点 Reload', colspan);
    return;
  }
  renderPlaceholder('加载中…', colspan);
  const status = $('filter').value;
  const url = status ? '/admin/api/feedback?status=' + encodeURIComponent(status) : '/admin/api/feedback';
  let res;
  try {
    res = await fetch(url, { headers: authHeaders() });
  } catch (e) {
    renderPlaceholder('请求失败: ' + e, colspan);
    return;
  }
  if (!res.ok) {
    let hint = '';
    if (res.status === 401) {
      hint = ' — admin_token 不对；dev 环境见 scripts/server/dev.sh，生产见 config.toml 的 [server].admin_token';
    }
    renderPlaceholder('请求失败: ' + res.status + hint, colspan);
    return;
  }
  const j = await res.json();
  const tbody = $('fb-table').querySelector('tbody');
  tbody.innerHTML = '';
  if (!j.items || j.items.length === 0) {
    renderPlaceholder('暂无反馈', colspan);
    return;
  }
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

// 首次进页面不自动 fetch，避免没填/填错 token 时直接吃 401。
if (tokenInput.value) {
  renderPlaceholder('已加载保存的 token，点 Reload 重新拉取', 7);
} else {
  renderPlaceholder('请输入 admin token 后点 Reload', 7);
}
