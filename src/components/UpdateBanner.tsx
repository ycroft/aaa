import { useEffect, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';

type State = 'idle' | 'available' | 'downloading' | 'failed';

export function UpdateBanner() {
  const [state, setState] = useState<State>('idle');
  const [version, setVersion] = useState<string>('');
  const [pending, setPending] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number>(0);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const u = await check();
        if (u) { setPending(u); setVersion(u.version); setState('available'); }
      } catch (e) {
        // Silent: log only.
        // eslint-disable-next-line no-console
        console.info('updater check failed', e);
      }
    }, 5_000);
    return () => clearTimeout(t);
  }, []);

  if (state === 'idle' || !pending) return null;

  const install = async () => {
    setState('downloading');
    try {
      let total = 0;
      let got = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress' && total > 0) {
          got += event.data.chunkLength;
          setProgress(Math.round((got / total) * 100));
        }
      });
      await relaunch();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.info('update install failed', e);
      setState('failed');
      setTimeout(() => setState('idle'), 1500);
    }
  };

  return (
    <div style={{
      padding: '6px 12px',
      background: '#fffae5',
      borderBottom: '1px solid #f0d97a',
      display: 'flex',
      gap: 12,
      alignItems: 'center',
      fontSize: 13,
    }}>
      <span>新版本 v{version} 可用</span>
      {state === 'available' && (
        <>
          <button onClick={install}>立即安装</button>
          <button onClick={() => setState('idle')}>稍后</button>
        </>
      )}
      {state === 'downloading' && <span>下载中 {progress}%</span>}
      {state === 'failed' && <span>下载失败</span>}
    </div>
  );
}
