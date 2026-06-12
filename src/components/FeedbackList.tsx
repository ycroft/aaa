import { useEffect, useState } from 'react';
import { api } from '../api';
import type { LocalTicket, RemoteTicketView } from '../types';

interface Row {
  local: LocalTicket;
  remote: RemoteTicketView | null;
  fetched: boolean;
}

export function FeedbackList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const t = await api.listLocalTickets();
        const initial: Row[] = t.items.map((local) => ({ local, remote: null, fetched: false }));
        if (!alive) return;
        setRows(initial);
        setLoading(false);
        await Promise.all(
          initial.map(async (r, i) => {
            try {
              const remote = await api.getFeedbackStatus(r.local.id, r.local.claim_token);
              if (!alive) return;
              setRows((rs) =>
                rs.map((x, j) => (j === i ? { ...x, remote, fetched: true } : x)),
              );
            } catch (e) {
              // eslint-disable-next-line no-console
              console.info('get_feedback_status silent fail', e);
            }
          }),
        );
      } catch (e) {
        // eslint-disable-next-line no-console
        console.info('list local tickets failed', e);
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (loading) return <div>加载中…</div>;
  if (rows.length === 0) return <div>还没有提交过反馈。</div>;
  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>时间</th>
          <th style={{ textAlign: 'left' }}>分类</th>
          <th style={{ textAlign: 'left' }}>标题</th>
          <th style={{ textAlign: 'left' }}>状态</th>
          <th style={{ textAlign: 'left' }}>备注</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.local.id}>
            <td>{new Date(r.local.created_at).toLocaleString()}</td>
            <td>{r.local.category}</td>
            <td>{r.local.title}</td>
            <td style={{ color: r.remote ? '#0a7' : '#999' }}>
              {r.remote?.status ?? '未知'}
            </td>
            <td>{r.remote?.admin_note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
