import { useEffect, useState } from 'react';
import { check, type Update } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { useT } from "../i18n";

type State = 'idle' | 'available' | 'downloading' | 'failed';

export function UpdateBanner() {
  const t = useT();
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
      <span>{t("update_banner.available", { version })}</span>
      {state === 'available' && (
        <>
          <button onClick={install}>{t("update_banner.install_now")}</button>
          <button onClick={() => setState('idle')}>{t("update_banner.later")}</button>
        </>
      )}
      {state === 'downloading' && <span>{t("update_banner.downloading", { percent: progress })}</span>}
      {state === 'failed' && <span>{t("update_banner.failed")}</span>}
    </div>
  );
}
