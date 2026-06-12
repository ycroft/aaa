import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  AppSettings,
  ProviderInfo,
  RemoteCacheInfo,
  RemoteHostInfo,
  RemoteHostInput,
  RemoteOpenResult,
  RemoteProviderInfo,
  SessionDetail,
  SessionSummary,
  SkillUsage,
} from "./types";

export const api = {
  getAppInfo: () => invoke<AppInfo>("get_app_info"),
  listProviders: () => invoke<ProviderInfo[]>("list_providers"),
  listSessions: (providerId: string, root?: string) =>
    invoke<SessionSummary[]>("list_sessions", { providerId, root: root ?? null }),
  loadSession: (providerId: string, sourcePath: string) =>
    invoke<SessionDetail>("load_session", { providerId, sourcePath }),
  sessionSkillUsage: (providerId: string, sourcePath: string) =>
    invoke<SkillUsage[]>("session_skill_usage", { providerId, sourcePath }),
  getSettings: () => invoke<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    invoke<void>("save_settings", { settings }),

  listRemotes: () => invoke<RemoteHostInfo[]>("list_remotes"),
  saveRemote: (input: RemoteHostInput) =>
    invoke<RemoteHostInfo>("save_remote", { input }),
  deleteRemote: (remoteId: string) =>
    invoke<void>("delete_remote", { remoteId }),
  remoteProbe: (remoteId: string) =>
    invoke<RemoteProviderInfo[]>("remote_probe", { remoteId }),
  listRemoteCaches: (remoteId: string) =>
    invoke<RemoteCacheInfo[]>("list_remote_caches", { remoteId }),
  remoteOpen: (remoteId: string, providerId: string, taskId: string) =>
    invoke<RemoteOpenResult>("remote_open", { remoteId, providerId, taskId }),
  remoteCancel: (taskId: string) =>
    invoke<void>("remote_cancel", { taskId }),
  exportSession: (
    providerId: string,
    sourcePath: string,
    targetDir: string,
    fileName: string,
  ) => invoke<string>("export_session", { providerId, sourcePath, targetDir, fileName }),
  checkCommandExists: (cmd: string) =>
    invoke<boolean>("check_command_exists", { cmd }),
  exportAllSessions: (providerId: string, root: string, targetDir: string) =>
    invoke<string[]>("export_all_sessions", { providerId, root, targetDir }),
  launchAgent: (cmdTemplate: string, workDir: string, promptContent: string) =>
    invoke<void>("launch_agent", { cmdTemplate, workDir, promptContent }),
};
