# M2+M3 完整可用管线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 M1 地基上补齐九阶段全部功能，交付"做完即可用"的完整平台：离线 Mock 全流程可走通出片，配真实 API Key 即切换真实生成。

**Architecture:** 服务端新增 design/material 查询/dubbing/shot 生成/cut 合成/library 六组能力，全部生成动作走 M1 的 Job 系统与能力描述；前端补齐 设计/素材/配音/分镜/视频/美化/成品/素材库/历史 九页。执行器一律**执行时实时解析绑定**（v2 铁律，修旧 Bug6）。

**Tech Stack:** 同 M1。合成用 FFmpeg concat/amix。

**验收（M2+M3 DoD）：** 浏览器完成完整生产链：贴剧本→三步生成→设计页给标签生成/上传设计图→素材页绑定（标签级+镜头级覆盖）→配音页逐句 TTS（Mock 正弦波）且镜头时长被真实音频时长锁定→分镜页生成关键图（抽卡/选定/失效角标）→视频页生成片段（时长=锁定时长）→美化页把选定片段合成成片→成品页可播放/下载 FINAL 资产→素材库能看到全部产物（视频有缩略图）→历史页可溯源。全程无手动搬文件。

---

## 契约增量

### S1. 服务端新增/扩展路由

| 方法/路径 | 功能 |
|---|---|
| GET `/api/tags/:id/designs`；POST `/api/tags/:id/designs/generate`（body { modelConfigId?, prompt? }）；POST `/api/tags/:id/designs/upload`（multipart）；POST `/api/tags/:id/canonical`（body { assetId }） | 设计：候选图列表 / AI 生成（Job）/ 上传 / 设为默认参考 |
| GET `/api/storyboards/:id/resolved-bindings` | 素材页数据源：每镜头每标签的 解析结果（镜头覆盖>标签默认）+ 来源层级 |
| POST `/api/shots/:id/sync-dubbing`；GET `/api/shots/:id/dubbing`；POST `/api/dubbing-lines/:id/generate`（body { speed? }）；POST `/api/storyboards/:id/dubbing/generate-all` | 配音：从对白同步生成行 / 查询 / 单句 TTS Job / 全部生成（batch） |
| POST `/api/shots/:id/generate-keyframe`（body { modelConfigId? }）；POST `/api/shots/:id/generate-video`（body { modelConfigId? }）；POST `/api/shots/:id/select-take`（body { slot, takeId }）；POST `/api/shots/:id/clear-stale`（body { slot, mode }） | 镜头产物：生成关键图 / 生成视频 / 选定 take / 消除失效标记 |
| GET `/api/episodes/:id/stale-shots` | 全局“待重生成”面板 |
| POST `/api/episodes/:id/cuts`（body { storyboardId }）→ 创建 Cut 并入队 COMPOSE_CUT；GET `/api/episodes/:id/cuts`；GET `/api/cuts/:id` | 成片：从选定 video takes 生成 Cut 并合成 |
| GET `/api/episodes/:id/assets`（本集素材=被本集 takes/bindings/dubbing 引用的资产）；`/api/projects/:id/assets` 增加 `source=` 过滤 | 素材库 本集/全部 切换 |

### S2. 生成执行器规格（modules/generation/）

统一入口 `registerGenerationExecutors({ registerExecutor, imageGen, videoGen, ttsGen })`，三个 Gen 都是可注入函数（缺省 = Mock 实现）：

- **KEYFRAME（GENERATE_IMAGE 复用）**：input `{ shotId, modelConfigId? }`。流程：读 shot（prompt、tags）→ **实时 resolveBinding** 每个标签 → 参考图 = 绑定资产 uri 列表 → `imageGen({ prompt, refUris, outPath })` → Asset(IMAGE, GENERATED, parents=绑定资产, jobId) → Take(KEYFRAME) → 首个 take 自动 selected → `clearStale(shotId,'KEYFRAME','regenerated')`。Mock imageGen：makePlaceholderImage（color 用 shotId 哈希取色，让不同镜头肉眼可区分）。
- **VIDEO（GENERATE_VIDEO）**：input `{ shotId, modelConfigId? }`。选定 keyframe take 的资产为 first_frame（无则 badRequest“请先生成并选定关键图”）；时长 = durationLockedMs ?? durationPlannedMs；`videoGen({ prompt, firstFrameUri, durationMs, outPath })` → Asset(VIDEO, parents=[keyframe asset], durationMs=probe) → **缩略图**：extractFrame(500ms) → thumb 资产文件（thumbUri 直接存 Asset 上，不建独立 Asset）→ Take(VIDEO) → 首个自动 selected → clearStale video。Mock videoGen：makePlaceholderVideo（同色系）。
- **TTS（GENERATE_TTS）**：input `{ dubbingLineId }`。行文本+speed → `ttsGen({ text, speed, outPath })` → Asset(AUDIO) → 行 status=READY、durationMs=probe → **重算镜头时长**：该 shot 全部 READY 行时长之和 + 每行 300ms 间隔 → `stale.onDubbingDurationChanged(shotId, 总时长)`（时长链路 v2 §3）。Mock ttsGen：makeSineWav，durationMs = max(800, 汉字数×220/speed)，频率按 voiceProfile/说话人哈希（不同角色不同音高，可听出差异）。
- **COMPOSE_CUT**：input `{ cutId }`。Cut.itemsJson = [{ shotId, takeId, assetUri }...]（创建 Cut 时由服务端从最新 storyboard 的 videoSelectedTake 快照——合成是不花钱的自动动作，可用快照）→ ffmpeg concat（先各段转码统一 720x1280/24fps 再 concat，稳妥）→ Asset(FINAL, parents=全部片段) → Cut.status=READY, outputAssetId。任一镜头无选定视频 → 创建时 badRequest 列出缺失镜头序号。
- 真实适配器（API executor 路径）：TEXT 已有；IMAGE 增加 openai-compatible `/images/generations`（b64_json → 存盘）；VIDEO/TTS 的真实适配器留接口（capability 里 vendor-specific，M2 先 Mock + 文档说明），modelConfigId 传入时按 provider 路由，无该模态真实适配器则报错提示用 Mock。

### S3. 前端页面增量（apps/web/src/pages/workflow/）

- **DesignStage**：三类 Tab（角色/场景/道具）；标签卡片：候选图墙（canonical 金框）、AI 生成（选模型 Select——数据来自 GET /capabilities?modality=image，含 Mock）、上传、设为默认；新建标签入口。
- **MaterialStage**：表格 = 镜头 × 标签矩阵（resolved-bindings 数据）；单元格显示解析出的图（缩略）+ 来源徽标（默认/覆盖）；点单元格弹层选资产（该标签候选设计图 + 项目图片资产）→ PUT bindings（shotId 传/不传区分覆盖与默认）；顶部“标签级默认绑定”卡片行；stale 波及提示（PUT 返回受影响数）。
- **DubbingStage**：按镜头分组的行列表：说话人/文本/语速 InputNumber/时长/状态/播放（audio 标签）/生成按钮；顶部“全部生成”；镜头小结行显示 计划时长 vs 锁定时长（超模型上限==15s 时黄色提示，M3 衔接组）。
- **StoryboardStage**：镜头卡片列：关键图大图（selected take）+ takes 缩略横排（点击切换 selected）+ “生成/重抽”按钮（选模型）+ stale 角标（点开 staleReasons 时间线 + “忽略”按钮）+ 绑定摘要。顶部“待重生成”汇总条（stale-shots 接口 + 批量重生成）。
- **VideoStage**：同 StoryboardStage 布局但槽位是视频：video 播放器 + takes 横排 + 生成按钮（时长显示）+ 首帧缩略。
- **EnhanceStage（M3 v2.0 最小集）**：按镜头顺序列出选定视频片段（缩略+时长，缺失的红字提示）→ “合成成片”按钮（POST cuts）→ 合成任务进度 → 完成跳成品页。历史 Cut 版本列表。
- **FinalStage**：Cut 版本列表 + 大播放器（outputAsset）+ 下载按钮（a href=uri download）+ 用料清单（itemsJson 镜头×片段表）。
- **LibraryPage**：Segmented 本集/全部 + 类型筛选；资产网格（图片直显/视频 thumbUri+时长角标/音频图标；点击 Modal 预览可播放）；回收/恢复；上传按钮。
- **HistoryPage**：GENERATED 资产时间线（缩略、类型、来源 Job 类型、时间、删除=回收、下载）+ 顶部类型筛选。

### S4. 桩替换与接线

- WorkflowShell 的 StageStub 替换为真实页面路由（design/material/dubbing/storyboard/video/enhance/final/library/history）。
- app.ts 注册新增路由与执行器；dubbing 完成回调、take 选择等接 stale 钩子。

---

## 任务分解

### Task F（Workflow 并行 ×4）：服务端 M2 模块
- [ ] F1 modules/design/*（designs CRUD+生成入队+上传+canonical；测试）
- [ ] F2 modules/dubbing/*（sync/查询/单句与全量生成入队+完成回调服务；测试含时长重算）
- [ ] F3 modules/generation/*（S2 四个执行器+Mock 三 Gen+select-take/clear-stale/stale-shots/resolved-bindings 路由；测试用注入的假 Gen，COMPOSE 用真 ffmpeg 拼两段小视频）
- [ ] F4 modules/cut/* + library 扩展（cuts 路由/本集资产/来源过滤/openai-compatible 图像适配器；测试）

### Task G（inline）：服务端集成 v2 + 全测试绿 + 提交

### Task H（Workflow 并行 ×4）：前端 M2 页面
- [ ] H1 DesignStage + MaterialStage
- [ ] H2 DubbingStage + StoryboardStage
- [ ] H3 VideoStage + EnhanceStage + FinalStage
- [ ] H4 LibraryPage + HistoryPage + WorkflowShell 接线（stage 路由替换桩）

### Task I（inline）：端到端完整验收（M2+M3 DoD 全流程浏览器走查）+ 修复 + 提交

## Self-Review 记录
- 时长链路：TTS 完成 → onDubbingDurationChanged → videoStale → 视频页提示重生成 → 生成用 locked 时长。闭环成立。
- Bug6 防复发：keyframe 执行器在执行时 resolveBinding；测试断言“换绑后重生成用新资产为 parent”。
- 付费产物不自动删：重抽只加 take 不删旧；Cut 用快照因合成免费可自动。
- 抽卡语义：takes 数组 + selected 指针 + 切换回调 stale，三页共用。
