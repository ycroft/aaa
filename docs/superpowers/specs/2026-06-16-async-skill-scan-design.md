# Async Skill Scan on Session List — Design

**Date:** 2026-06-16
**Status:** Approved (brainstorming phase)
**Owner:** ycroft

## Background

打开数据源时左侧 session list 会卡顿，因为为了在每行展示已使用的 skill chips，`list_sessions` 走到了"扫整份原生日志"的程度：

- `core/src/providers/anthropic_jsonl.rs::scan_summary` 注释里写"Cheap pass: only inspect a few fields so listing many sessions stays fast"，但实际上现在它对每一行都要进 `match v.get("type")`，走 user/assistant 分支累计 `det_obs`，再用 `SkillRegistry` + `SkillDetector` replay 一次填 `summary.used_skills`。一个 N 行 jsonl 是 O(N) 完整扫描，乘上一个根目录下的 M 个 session，开数据源的同步耗时就是 ΣO(N_i)。Claude Code 与 Code Agent 3.x 共用此路径。
- `core/src/providers/opencode.rs::list_sessions` 里 `for s in sessions.iter_mut()` 又一次给每个 session 调 `collect_used_skills(&conn, &s.session_id, &reg)` 跑 SQL，N 个 session 累计 N 次查询。
- 前端 `SessionList.tsx` 直接读 `summary.used_skills`，所以"扫晚一点"对它而言就是"前 3 个 chip 晚一点出现"。
- 点开会话时右侧 timeline 的 skill 标记走的是 `load_session → walk_session_nodes → det.used_skill_ids()`，跟列表那一遍解耦。

也就是说"打开慢"完全是**列表层**这一层造成的，把 skill 检测从 `list_sessions` 路径里抽出去做成异步后台 pass，开窗体验立刻就回来了，右侧 timeline / SkillChips / 单 session 的 skill_usage stats 一概不受影响。

## Goals

1. `list_sessions` 拉回到原本的 cheap pass 语义：只读 cwd / title / 起止时间 / token 累计 / message_count 这类 O(几行) 的字段；不再扫整份日志。`summary.used_skills` 初始为空。
2. 新增一条独立、可取消的后台 pass，按 source_path 逐 session 算 `used_skills`，通过 Tauri event 流推给前端逐行 patch。
3. 状态栏在扫描期间显示 `scanning skills (k/N)`，扫完切回正常 `loaded sessions` 文案。
4. session list 行内 chips 区域留空，扫完后 chips 用 CSS 淡入呈现。
5. `load_session` 路径与产出**一字不动**——右侧 timeline、SkillChips、`session_skill_usage` 统计照旧。

## Non-Goals

- 不加磁盘缓存（重开数据源仍重新扫描；纯异步已经解决"开窗卡"这个核心问题）。
- 不并行 scan_session_skills（先顺序，未来量级真的爆了再加 worker pool）。
- 不引入 virtualized 列表 / 滚到哪扫到哪（用户量级 < 几百个 session，整体后台扫一遍即可）。
- 不改变 `summary.used_skills` 字段语义/类型，TS 端不动 mirror 形状。

## Decisions (from brainstorming)

| 决策点 | 选择 |
|--------|------|
| 扫描期间 chips 区域 | 完全留空，扫完淡入 |
| 扫描进度反馈 | 状态栏文案 `scanning skills (k/N)` |
| 后端 API 形状 | 独立命令 `start_skill_scan` + 逐 session 事件 + `cancel_skill_scan` |
| 生命周期 | 关 panel / 切 root → 立即 cancel；不持久化扫描结果 |
| 串/并 | 串行（顺序遍历 source_paths） |
| 失败处理 | 单个 session 抛错 → 当作 `used_skills = []`，仍 emit 进度，继续下一个 |

## Architecture

数据流：

```
SessionPanel mount / refreshSessions
  ├─ list_sessions(provider, root)  ──────▶ SessionSummary[]（used_skills 全空）
  │                                       ▶ SessionList 立刻渲染
  └─ start_skill_scan(provider_id, scan_id, source_paths)
        └─ 后台 thread：for path in source_paths
             │   if cancelled.load() { break }
             │   provider.scan_session_skills(path) → Vec<String>
             └─▶ emit "skill-scan-progress" {scan_id, source_path, used_skills, k, n}
                   └─ SessionPanel: setSessions(prev → patch matching row)
                                    setStatus("scanning skills (k/N)")
        emit "skill-scan-done" {scan_id, total}

panel unmount / root 变更 / 重新 refresh
  └─ cancel_skill_scan(scan_id) + unsubscribe listeners
```

`SessionProvider` trait 多一个方法 `scan_session_skills(&self, source_path: &Path) -> Result<Vec<String>>`；默认空实现。Tauri 命令层注册 `SkillScanTasks(Mutex<HashMap<scan_id, Arc<AtomicBool>>>)`，与现有 `RemoteTasks` 的取消模式同形。

## Components

### 1. core: trait method

`core/src/providers/mod.rs`

```rust
pub trait SessionProvider: Send + Sync {
    // ... existing methods ...

    /// Extract skill IDs used in a single session, by source_path.
    /// Default empty so providers without skill detection cost zero.
    fn scan_session_skills(&self, _source_path: &Path) -> anyhow::Result<Vec<String>> {
        Ok(Vec::new())
    }
}
```

### 2. core: anthropic_jsonl 拆解

`core/src/providers/anthropic_jsonl.rs`：

- 新增 `pub fn extract_used_skills(path: &Path, skill_roots_fn: &dyn Fn(Option<&Path>) -> Vec<PathBuf>) -> Result<Vec<String>>`：内容是把 `scan_summary` 现有的 cwd 探测 + `det_obs` 累积 + `SkillObs` replay 那段抽出来，不依赖 `SessionSummary`。
- `scan_summary` 移除 `skill_roots_fn` 参数、删去 `det_obs` / `reg` / `SkillObs` 相关代码与回放逻辑、`summary.used_skills` 不再赋值（保持默认空 Vec）。回归到注释承诺的 cheap pass。
- `list_sessions` 移除 `skill_roots_fn` 参数。
- `load_session` 不变（它依然通过 `walk_session_nodes` 走完整 detector，给 `summary.used_skills` + tps 计算服务）。

`claude_code.rs` / `code_agent_3x.rs`：

- `list_sessions` 调用同步去掉 `skill_roots_fn`。
- 新增 `fn scan_session_skills(&self, p) { anthropic_jsonl::extract_used_skills(p, &|cwd| self.skill_roots(cwd)) }`。

### 3. core: opencode 拆解

`core/src/providers/opencode.rs`：

- `list_sessions` 中 `for s in sessions.iter_mut() { ... collect_used_skills ... }` 整段删掉。
- `collect_used_skills` 当前是 `fn`（私有），改成 `pub(crate) fn` 或保持私有但被 `scan_session_skills` 调用——实质上 `scan_session_skills` 内部解 `parse_source_path(source_path)?` 拿 `(db_path, session_id)`，开 ro 连接，构造 SkillRegistry，调 `collect_used_skills`，返回 `Vec<String>`。

### 4. src-tauri: state + commands

`src-tauri/src/commands.rs`（或新文件 `skill_scan.rs`，按现有 `commands.rs` 大小决定）：

```rust
pub struct SkillScanTasks(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

#[derive(Serialize, Clone)]
struct SkillScanProgress<'a> {
    scan_id: &'a str,
    source_path: &'a str,
    used_skills: &'a [String],
    k: usize,  // 1-based, "this row is #k of n"
    n: usize,
}

#[derive(Serialize, Clone)]
struct SkillScanDone<'a> { scan_id: &'a str, total: usize }

#[tauri::command]
pub fn start_skill_scan(
    app: AppHandle,
    tasks: State<'_, SkillScanTasks>,
    provider_id: String,
    scan_id: String,
    source_paths: Vec<String>,
) -> Result<(), String>;

#[tauri::command]
pub fn cancel_skill_scan(
    tasks: State<'_, SkillScanTasks>,
    scan_id: String,
) -> Result<(), String>;
```

`start_skill_scan` 实现要点：

- 注册 `Arc<AtomicBool>` 到 `tasks` 表，key = scan_id。
- `std::thread::spawn`（同步 I/O，无需 async runtime）：
  - `let n = source_paths.len();`
  - `for (i, path) in source_paths.iter().enumerate()`：
    - 检查 cancel flag，true → break。
    - `let used = provider.scan_session_skills(Path::new(path)).unwrap_or_default();`（抛错就当空，warn! 一行）。
    - `app.emit("skill-scan-progress", SkillScanProgress { scan_id, source_path: path, used_skills: &used, k: i+1, n })`。
  - 收尾 `app.emit("skill-scan-done", SkillScanDone { scan_id, total: n })`。
  - `tasks.lock().remove(scan_id)`。
- 立即 return `Ok(())`，不等待后台。

`cancel_skill_scan`：复刻 `remote_cancel`——找到 flag 翻 true，找不到返回 Ok（幂等）。

`main.rs`：`.manage(SkillScanTasks::default())` + invoke handler 注册两个命令。

### 5. src/api.ts

```ts
startSkillScan: (providerId: string, scanId: string, sourcePaths: string[]) =>
  invoke<void>("start_skill_scan", { providerId, scanId, sourcePaths }),
cancelSkillScan: (scanId: string) =>
  invoke<void>("cancel_skill_scan", { scanId }),
```

### 6. SessionPanel 接入

`src/components/SessionPanel.tsx`：

- `refreshSessions` 拿到 list 后：
  ```ts
  const scanId = crypto.randomUUID();
  const unlistenProgress = await listen<SkillScanProgressPayload>("skill-scan-progress", (e) => {
    if (e.payload.scan_id !== scanId) return;
    setSessions(prev => prev.map(s =>
      s.source_path === e.payload.source_path
        ? { ...s, used_skills: e.payload.used_skills }
        : s
    ));
    setSkillScanProgress({ k: e.payload.k, n: e.payload.n });
  });
  const unlistenDone = await listen<SkillScanDonePayload>("skill-scan-done", (e) => {
    if (e.payload.scan_id !== scanId) return;
    setSkillScanProgress(null);
  });
  await api.startSkillScan(backend.provider.id, scanId, list.map(s => s.source_path));
  // store unsubscribe + scanId for cleanup
  ```
- `useEffect` cleanup（或 `refreshSessions` 重入时）：unsubscribe listeners + `api.cancelSkillScan(scanId)`。
- 状态栏文案：当 `skillScanProgress != null` 时优先显示 `t("status.scanning_skills", { k, n })`，否则保持现有逻辑。
- 一个新 state hook 管 listener 句柄、scanId、进度（用一个 ref + useState 组合，避免每次 setState 都重订阅）。

### 7. UI: chips 淡入

`src/styles/app.css`：

```css
@keyframes skillFadeIn {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: none; }
}
.session-list .skill-pill { animation: skillFadeIn 240ms ease-out; }
```

由于 `SessionList` 渲染 `(s.used_skills ?? []).slice(0, 3).map(sid => <span key={`skill-${sid}`}/>)`，从空数组到非空数组就是新 DOM 节点挂载，CSS 动画自动触发。无需 React 改动。

### 8. i18n

`src/i18n/zh.ts`（权威源）+ `en.ts`：新增 `status.scanning_skills` = `"扫描技能… {k}/{n}"` / `"Scanning skills… {k}/{n}"`。`DeepStrings` 类型卫戍会强制 en 镜像。

## Tests

`core/tests/skill_scan.rs`（新文件）或追加到 `core/tests/smoke.rs`：

1. **`list_sessions_does_not_populate_used_skills_anymore`** — 用 `tests/fixtures/` 里的 claude-code jsonl，断言 `provider.list_sessions(root)` 返回的所有 summary `used_skills.is_empty()`。
2. **`scan_session_skills_extracts_skills_from_jsonl`** — 同一 fixture，调 `provider.scan_session_skills(source_path)`，断言返回非空 `Vec<String>` 且包含已知 skill id。
3. opencode 同样两条对照测试（如果 opencode fixture 里有 skill 记录）。

不写 Tauri 命令层 e2e（项目里也没此惯例，且新命令逻辑就是 trait 调用 + 事件 emit 的薄壳，事件本身由前端联调验证）。

## Invariants

- 不引入 `match provider_id` 字符串分支：所有 provider 通过 `providers::find` + 新 trait 方法走同一条路径。
- `summary.used_skills` 字段 / 类型 / 序列化形态一字不变；只是初始化时机变成"列表返回后异步 patch"。
- `load_session` 实现路径与 wire 输出零变更。
- 新事件名走 kebab-case：`skill-scan-progress` / `skill-scan-done`，与现有 `remote-progress` 对齐。
- `cancel_skill_scan` 幂等。

## Versioning

- minor bump（新增 Tauri 命令 + 可见行为变化：列表"先到位、chips 后淡入"）。
- 需要同步 4 处版本字段：`package.json` / `src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `core/Cargo.toml`。
- `release-notes.txt` 顶部追加用户视角描述：
  > vX.Y.0
  > ----
  > - 打开数据源更快：会话列表立即出现，使用过的技能标签会在后台扫描完成后逐条淡入。
- `aaa-wire` 不涉及，`SCHEMA_VERSION` 不动。
- server 不涉及。

## Rollout

按 superpowers 工作流：spec → plan → TDD 实施 → 测试通过 → bump 版本 + release notes 同 commit → push origin dev/bugfix。
