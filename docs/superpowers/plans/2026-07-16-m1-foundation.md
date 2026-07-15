# M1 平台地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 AI 漫剧平台的可运行地基：全量数据模型、资产血缘、Job 系统、厂商能力配置、失效传播引擎、剧本三步生成（patch 语义），前端九阶段骨架 + 项目/剧本/后台三个可用页面。

**Architecture:** pnpm 单仓；apps/server = Fastify + Prisma(SQLite dev)，模块化按业务域；apps/web = Vite + React + AntD5；packages/shared = zod 契约（实体枚举/能力描述/patch 协议/API 类型），前后端同源。Job 为 DB 队列 + 进程内 worker；Mock 执行器用 FFmpeg 合成真实占位媒体，保证端到端可验证。

**Tech Stack:** TypeScript, Fastify 5, Prisma 6 (SQLite), zod, vitest, React 18, Vite 6, Ant Design 5, TanStack Query, react-router 6。

**验收（M1 DoD）：** `pnpm dev` 起前后端；浏览器完成 创建项目→分集→贴剧本→三步生成→分镜卡片；Job 面板可见任务流转；后台可增删厂商与模型；`pnpm test` 全绿（失效传播/绑定解析/patch 应用/Job 状态机有单测）。

---

## 契约总览（先于一切任务锁定）

### C1. 数据模型（`apps/server/prisma/schema.prisma`）

SQLite 约束：枚举用 `String`（合法值由 shared zod 枚举定义），JSON 用 `String`（列名 `*Json`）。核心实体与关系（完整 schema 见仓库文件，本计划为唯一事实源的镜像说明）：

- `Project` 1-* `Episode` / `Tag` / `Asset` / `VoiceProfile` / `Job`
- `Tag`: `type` ∈ CHARACTER|SCENE|PROP，`name` 项目内唯一，`canonicalAssetId?`
- `Asset`: `type` ∈ IMAGE|VIDEO|AUDIO|FRAME|VOICE_SAMPLE|FINAL；`source` ∈ GENERATED|UPLOADED|EXTRACTED；`uri`（本地相对路径）；`metaJson`；`status` ∈ ACTIVE|RECYCLED；血缘 = `AssetParent(assetId, parentId)` 多对多 + `jobId?`
- `Episode` 1-* `ScriptDraft`（恰一个 `isMain`）/ `Storyboard` / `Binding` / `Cut`
- `Storyboard`: `scriptDraftId`，`version` 自增，`stale`；1-* `Shot`
- `Shot`: `sortOrder`,`sourceText`,`imagePrompt`,`videoPrompt`,`durationPlannedMs`,`durationLockedMs?`,`keyframeSelectedTakeId?`,`videoSelectedTakeId?`,`keyframeStale`,`videoStale`,`staleReasonsJson`；`ShotTag(shotId, tagId)`；1-* `DialogueLine(speakerTagId?, isNarrator, text, sortOrder)`
- `Binding`: `(episodeId, tagId, shotId?) → assetId`；`shotId` 为空=标签级默认，非空=镜头级覆盖；唯一约束 `(episodeId, tagId, shotId)`
- `DubbingLine`: `shotId`,`dialogueLineId?`,`voiceProfileId?`,`speed`,`audioAssetId?`,`durationMs?`,`status`
- `Take`: `(shotId, slot∈KEYFRAME|VIDEO, assetId, jobId?, createdAt)`
- `Job`: `type`,`status` ∈ QUEUED|RUNNING|SUCCEEDED|FAILED|CANCELED，`progress`,`inputJson`,`outputJson?`,`error?`,`executor` ∈ MOCK|API|GPU，`providerConfigId?`,`modelKey?`,`attempts`,`maxAttempts`,`batchId?`
- `ProviderConfig`: `name`,`vendor`,`category` ∈ TEXT|IMAGE|VIDEO|TTS，`baseUrl`,`apiKey`,`enabled`,`metaJson`；1-* `ModelConfig(key,label,modality,capabilityJson,enabled,sortOrder)`
- `Cut`: `episodeId`,`version`,`itemsJson`,`audioTracksJson`,`outputAssetId?`,`status`
- M3 占位：`WorkflowTemplate`,`GpuNode`（建表不建功能）

### C2. shared 包（`packages/shared/src/`）

- `enums.ts`：上述全部枚举的 zod 枚举 + TS 类型。
- `capability.ts`：能力描述 schema：
  ```ts
  CapabilityDescriptor = {
    modality: 'text'|'image'|'video'|'tts',
    input: Array<'prompt'|'first_frame'|'first_last_frame'|'ref_images'|'voice_sample'|'audio'>,
    output?: { resolutions?: string[], ratios?: string[], maxDurationS?: number },
    paramsSchema?: Record<string, unknown>,   // JSON Schema，前端渲染表单
    flags?: { supportsVoiceReference?: boolean, supportsPreview?: boolean }
  }
  ```
- `storyboard-patch.ts`：分镜补丁协议（v2 §4 的机制核心）：
  ```ts
  StoryboardPatchOp =
    | { op:'add_shot', afterShotId?: string|null, shot: NewShotInput }
    | { op:'update_shot', shotId: string, fields: Partial<ShotEditable> }
    | { op:'remove_shot', shotId: string }
    | { op:'reorder', shotIds: string[] }
  NewShotInput = { sourceText, imagePrompt, videoPrompt, durationPlannedMs,
                   tags: Array<{ name, type }>,        // 复用现有名或标 pending
                   dialogue: Array<{ speaker?: string, isNarrator: boolean, text: string }> }
  ```
- `api.ts`：REST 请求/响应 zod schema（各路由 body/response）。
- 构建：tsup（cjs+esm+dts）。

### C3. API 路由表（`/api` 前缀，JSON，zod 校验）

| 方法/路径 | 功能 |
|---|---|
| GET/POST `/projects`；GET/PATCH/DELETE `/projects/:id` | 项目 CRUD（含归档） |
| GET/POST `/projects/:id/episodes`；PATCH/DELETE `/episodes/:id` | 分集 CRUD |
| GET/POST `/projects/:id/tags`；PATCH `/tags/:id` | 标签管理（含 canonical 设置） |
| GET `/projects/:id/assets`；POST `/projects/:id/assets/upload`（multipart）；POST `/assets/:id/recycle`,`/restore`；GET `/assets/:id/lineage` | 资产库 + 血缘 |
| GET/POST `/episodes/:id/script-drafts`；PATCH `/script-drafts/:id`（含 setMain）| 剧本稿 |
| POST `/script-drafts/:id/generate-storyboard` | 三步生成：创建 TEXT Job，产出 patch → 新 Storyboard 版本 |
| GET `/episodes/:id/storyboards`；GET `/storyboards/:id`（含 shots+tags+dialogue）；POST `/storyboards/:id/apply-patch` | 分镜查询 + patch 应用 |
| GET/PUT `/episodes/:id/bindings` | 绑定读写（标签级/镜头级） |
| GET `/projects/:id/jobs`；GET `/jobs/:id`；POST `/jobs/:id/cancel`,`/retry` | Job 面板 |
| GET/POST `/admin/providers`；PATCH/DELETE `/admin/providers/:id`；POST `/admin/providers/:id/test` | 厂商配置 + 连通测试 |
| GET/POST `/admin/providers/:id/models`；PATCH/DELETE `/admin/models/:id` | 模型能力配置 |
| GET `/capabilities?modality=` | 前台动态模型列表（enabled 的 ModelConfig 投影） |

### C4. 核心服务签名

```ts
// modules/job/service.ts
enqueueJob(input: { projectId, type: JobType, executor, inputPayload, providerConfigId?, modelKey?, batchId? }): Promise<Job>
// worker：轮询领取 QUEUED（事务置 RUNNING），按 (type) 从 executorRegistry 取执行器
// executor 契约：
type JobExecutor = (ctx: { job: Job, updateProgress(p: number): Promise<void> }) => Promise<{ outputAssetIds?: string[], output?: unknown }>

// modules/stale/service.ts —— v2 §2.2 传播表的直接实现（唯一实现处）
onScriptDraftChanged(draftId): 关联 storyboard.stale = true
onStoryboardPatched(storyboardId, changedShotIds, removedShotIds): 改动镜头 keyframe/video 标 stale；删除镜头产物回收
onBindingChanged(episodeId, tagId, shotId?): 受影响镜头（覆盖规则见下）keyframe 标 stale
onDubbingDurationChanged(shotId, oldMs, newMs): |Δ|>500ms → video 标 stale
onTakeSelected(shotId, slot): slot=KEYFRAME → video 标 stale；均记录 staleReasonsJson 追加 { source, at, detail }
clearStale(shotId, slot, mode: 'regenerated'|'ignored')

// modules/binding/service.ts
resolveBinding(episodeId, tagId, shotId): Promise<assetId|null>  // 镜头级覆盖 > 标签级默认；任务执行时实时调用（修 Bug6）

// modules/script/generate.ts —— 三步生成
// TEXT Job：输入剧本全文+项目标签词表 → LLM(OpenAI兼容) 或 MockText → StoryboardPatch[]（zod 校验，失败重试1次）
// 成功后 applyPatch 创建新 Storyboard 版本（复制未变镜头，应用 ops —— 从机制上杜绝“重复累加”）

// modules/provider/adapters/openai-compatible.ts
chatComplete(cfg: { baseUrl, apiKey, model }, messages, opts?: { jsonSchema? }): Promise<string>
// modules/provider/adapters/mock.ts —— 无 key 时可用：
// MockText: 按拆分策略（10–15s/镜头）确定性生成分镜 patch；MockImage/MockVideo/MockTts: FFmpeg 合成占位 png/mp4/wav
```

### C5. 前端页面结构（`apps/web/src/`）

```
api/client.ts, api/hooks.ts          # fetch 封装 + react-query hooks
layouts/AppLayout.tsx                # 顶栏 + 内容区
pages/projects/ProjectsPage.tsx      # 项目卡片墙 + 新建
pages/projects/EpisodesPage.tsx      # 分集卡片 + 流程化制作入口
pages/workflow/WorkflowShell.tsx     # 九阶段 tab 导航（剧本…历史），路由 /projects/:pid/episodes/:eid/:stage
pages/workflow/ScriptStage.tsx       # 左：剧本稿列表(主剧本星标) 中：内容编辑+三步生成按钮 右：分镜卡片列(可折叠)
pages/workflow/StageStub.tsx         # 其余阶段占位（标注 M2/M3）
pages/jobs/JobsPanel.tsx             # 任务抽屉：状态/进度/重试/取消，轮询刷新
pages/admin/ProvidersPage.tsx        # 厂商卡片 + 模型能力表格 + 连通测试
```

---

## 任务分解

### Task A（inline，本会话直接执行）：脚手架 + 契约落盘
**Files:** 根配置（package.json/pnpm-workspace.yaml/tsconfig.base.json/.gitignore）、packages/shared 全部源码、apps/server/prisma/schema.prisma、apps/server/apps/web 的 package.json+tsconfig+入口壳。
- [ ] git init + 初始 scaffold 提交
- [ ] shared 包实现并 `pnpm --filter shared build` 通过
- [ ] `prisma migrate dev` 建库成功，提交

### Task B（Workflow 并行，5 个子代理，文件集互斥）：server 模块
每个子代理拿到：本计划 C1–C4 契约 + 已落盘的 shared 包/prisma schema + 指定文件集。TDD：先写 vitest 再实现。
- [ ] B1 `lib/*`+`modules/job/*`（含 mock 媒体执行器；测试：状态机流转/重试/取消）
- [ ] B2 `modules/provider/*`（CRUD、能力投影、openai-compatible+mock 适配器、连通测试；测试：能力过滤）
- [ ] B3 `modules/asset/*`+`modules/binding/*`（上传/血缘/回收；绑定解析；测试：覆盖优先级、lineage 查询）
- [ ] B4 `modules/stale/*`（传播表全量实现；测试：§2.2 每行一个用例）
- [ ] B5 `modules/{project,episode,tag,script,storyboard,dubbing}/*` 路由+服务（patch 应用；测试：patch 幂等、版本复制）

### Task C（inline）：server 集成
- [ ] app.ts 注册全部路由 + worker 启动 + 种子数据脚本
- [ ] `pnpm --filter server test` 全绿、`build` 通过，提交

### Task D（Workflow 并行，3 个子代理）：web 页面
- [ ] D1 壳+路由+api client+项目/分集页
- [ ] D2 WorkflowShell+ScriptStage（核心页）
- [ ] D3 JobsPanel+ProvidersPage
- [ ] `pnpm --filter web build` 通过，提交

### Task E（inline）：端到端验证
- [ ] `pnpm dev` 起双端，浏览器走查 M1 DoD 全流程
- [ ] 修复发现的问题，最终提交

---

## Self-Review 记录
- 覆盖检查：v2 §1(C1) §2(B4) §4-patch(C2/B5) §7(B1) §8(B2/C3 capabilities) §9 的 M1 部分(C5)。设计/素材/配音/分镜/视频页为 M2 范围，M1 以 StageStub 占位——与 ADR-4 里程碑表一致。
- 类型一致性：枚举唯一定义在 shared/enums.ts，prisma String 列在服务层 parse；patch 协议唯一定义在 shared/storyboard-patch.ts。
- 无占位符声明：模块内部代码由执行阶段的子代理按 TDD 现场产出，契约（类型/签名/路由/规则表）已全部在本文档与仓库契约文件中给死。
