import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  AppSettings,
  FeedbackInput,
  HubStatus,
  LocalTicket,
  LocalTickets,
  ProviderInfo,
  RemoteCacheInfo,
  RemoteHostInfo,
  RemoteHostInput,
  RemoteOpenResult,
  RemoteProviderInfo,
  RemoteTicketView,
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
  startSkillScan: (providerId: string, scanId: string, sourcePaths: string[]) =>
    invoke<void>("start_skill_scan", { providerId, scanId, sourcePaths }),
  cancelSkillScan: (scanId: string) =>
    invoke<void>("cancel_skill_scan", { scanId }),
  exportSessions: (
    providerId: string,
    sourcePaths: string[],
    root: string | null,
    targetDir: string,
    scope: "single" | "all",
  ) =>
    invoke<string>("export_sessions", { providerId, sourcePaths, root, targetDir, scope }),
  checkCommandExists: (cmd: string) =>
    invoke<boolean>("check_command_exists", { cmd }),
  launchAgent: (cmdTemplate: string, workDir: string, promptContent: string) =>
    invoke<void>("launch_agent", { cmdTemplate, workDir, promptContent }),

  // ---- aaa-hub: silent on transport failure (returns Disconnected/null) ----
  hubStatus: () => invoke<HubStatus>("hub_status"),
  submitFeedback: (input: FeedbackInput) =>
    invoke<LocalTicket | null>("submit_feedback", { input }),
  getFeedbackStatus: (id: string, token: string) =>
    invoke<RemoteTicketView | null>("get_feedback_status", { id, token }),
  listLocalTickets: () => invoke<LocalTickets>("list_local_tickets"),
  refreshHub: () => invoke<void>("refresh_hub"),
};
