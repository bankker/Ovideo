# Ovideo · AI 漫剧创作平台

从剧本到成片的一站式 AI 漫剧（短剧）生产平台。对标并重构自 MECHA 系统，需求与设计见 [docs/](docs/)。

## 快速开始

```bash
pnpm install                 # 安装依赖（根目录）
cd apps/server
pnpm exec prisma migrate dev # 初始化数据库（SQLite，零依赖）
pnpm db:seed                 # 种子：示例项目 + Mock/DeepSeek 文本厂商
cd ../..
pnpm dev                     # 同时启动 后端(8787) + 前端(5173)
```

打开 http://localhost:5173 —— 无需任何 API Key 即可离线走通全流程（Mock 执行器用 FFmpeg 合成占位媒体）。要接真实模型：管理后台 → API 厂商配置 → 填入 Key 并启用（文本走 OpenAI 兼容协议，DeepSeek/通义/Kimi 等即插即用；图像走 /images/generations）。

**环境要求**：Node ≥ 20、pnpm ≥ 9、FFmpeg 在 PATH 中。

## 制作流程（九阶段）

```
剧本(三步生成/patch 版本) → 设计(标签→候选图→默认参考) → 素材(镜头×标签绑定矩阵)
→ 配音(逐句 TTS，真实时长锁定镜头时长) → 分镜(关键图·抽卡) → 视频(I2V·按锁定时长)
→ 美化(拼接合成) → 成品(播放/下载/用料清单) + 素材库/历史
```

核心机制（详见 [docs/需求文档v2-功能设计优化.md](docs/需求文档v2-功能设计优化.md)）：

- **标签驱动一致性**：剧本阶段提取的角色/场景/道具标签是项目级锚点，绑定变更全局联动。
- **失效传播**：上游变更只把下游标记 stale（角标+溯源时间线），付费产物从不自动删除/重生成。
- **抽卡语义**：每个产物槽 N 个 take + 一个 selected，随时回切。
- **执行时解析绑定**：生成任务出队时才读取绑定关系，杜绝旧系统"换绑不生效"缺陷。
- **能力描述驱动**：后台配置模型（含能力 JSON），前台按 modality 动态渲染选项，零硬编码。

## 仓库结构

```
packages/shared/   # zod 契约：枚举、能力描述、分镜 patch 协议、API schema
apps/server/       # Fastify + Prisma(SQLite)；modules/ 按业务域；DB 队列 Job 系统
apps/web/          # Vite + React 18 + AntD5；pages/ 按九阶段
docs/              # 需求 v1/v2、架构决策、实施计划
```

测试：`cd apps/server && pnpm test`（262 用例：失效传播规则表逐行、patch 应用、绑定解析、Job 状态机、各执行器含真实 FFmpeg 用例）。

## 路线图

- **已完成（M1~M4）**：九阶段全流程可用、Job 系统、厂商能力配置（预置库/一键接入/自动发现）、失效传播、**全真实模型管线**——文本（豆包/千问/DeepSeek 等 OpenAI 兼容）、图像（Seedream i2i 参考图）、视频（Seedance 异步任务）、**语音（Qwen-TTS，含 atempo 语速后处理）**；**对话式剧本修改**（多轮对话→patch 预览→确认应用）、**ShotGroup 首尾帧衔接组**、**单段增强**（放大/补帧，本地 FFmpeg）、标签治理（@ 引用/语义判重/合并）。**无 Mock 原则**：未配置模型时明确报错引导配置，绝不静默产出占位内容。
- **M3 完整版（需外部资源）**：GPU 集群（ComfyUI Agent 心跳注册，接管放大/补帧/对口型）、真实视频/TTS 厂商适配器（Seedance/海螺等，需 API Key 联调）、剪辑器 v2.1（OpenCut 集成评估）。
- **M4**：声音样本一致性（抽声样本传递）、成品共享反馈闭环、费用余额看板、前台用户回收站。
