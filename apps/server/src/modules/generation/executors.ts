// 生成执行器（M2 S2 核心）：GENERATE_IMAGE（keyframe/design 分派）、GENERATE_VIDEO、GENERATE_TTS。
// 铁律（v2，修旧系统 Bug6）：绑定在【执行时】实时 resolveBinding，禁止创建任务时快照。
// 付费产物从不物理删除：重抽只追加 take；首个 take 自动 selected。
import { z } from 'zod';
import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseJson } from '../../lib/json.js';
import { allocFilePath, fileSize, uriToAbsPath } from '../../lib/storage.js';
import { extractFrame, probeDurationMs } from '../../lib/ffmpeg.js';
import { registerExecutor, type JobExecutor } from '../job/registry.js';
import { resolveBinding } from '../binding/service.js';
import { createAsset } from '../asset/service.js';
import { clearStale, onDubbingDurationChanged } from '../stale/service.js';
import type { GenModelCfg, ImageGen, TtsGen, VideoGen } from './gens.js';

/** 三个可注入的生成函数（缺省 = Mock，集成阶段可换真实适配器） */
export interface GenerationGens {
  imageGen: ImageGen;
  videoGen: VideoGen;
  ttsGen: TtsGen;
}

const KeyframeInputSchema = z.object({
  kind: z.literal('keyframe'),
  shotId: z.string(),
  modelConfigId: z.string().optional(),
});

const DesignInputSchema = z.object({
  kind: z.literal('design'),
  tagId: z.string(),
  prompt: z.string().min(1),
  modelConfigId: z.string().optional(),
});

const ImageInputSchema = z.discriminatedUnion('kind', [KeyframeInputSchema, DesignInputSchema]);

const VideoInputSchema = z.object({
  shotId: z.string(),
  modelConfigId: z.string().optional(),
});

const TtsInputSchema = z.object({
  kind: z.literal('dubbing'),
  dubbingLineId: z.string(),
  modelConfigId: z.string().optional(),
});

/**
 * modelConfigId → 模型调用配置：模型/厂商任一 disabled 直接抛错（不允许静默降级），
 * 未传 modelConfigId 返回 undefined（走 Mock/缺省实现）。
 */
async function resolveModelCfg(
  db: PrismaClient,
  modelConfigId: string | undefined,
): Promise<GenModelCfg | undefined> {
  if (!modelConfigId) return undefined;
  const model = await db.modelConfig.findUnique({
    where: { id: modelConfigId },
    include: { provider: true },
  });
  if (!model) throw notFound('模型配置');
  if (!model.enabled) throw badRequest(`模型已停用：${model.label}`);
  if (!model.provider.enabled) throw badRequest(`厂商已停用：${model.provider.name}`);
  return { baseUrl: model.provider.baseUrl, apiKey: model.provider.apiKey, modelKey: model.key };
}

/** 读镜头（含分镜、标签），不存在抛 404 */
const TAG_TYPE_LABEL: Record<string, string> = { CHARACTER: '角色', SCENE: '场景', PROP: '道具' };
const TAG_TYPE_ORDER: Record<string, number> = { CHARACTER: 0, PROP: 1, SCENE: 2 };

/**
 * 解析提示词中的 @标签名 提及（显式指定参考图）。
 * 标签名以空白或常见标点结尾；保持出现顺序、去重。
 */
const MENTION_RE = /@([^\s@，。；、,;.!？?！:：()（）【】\[\]"'`]+)/g;

export function parseMentions(prompt: string): string[] {
  const names: string[] = [];
  for (const m of prompt.matchAll(MENTION_RE)) {
    const name = m[1].trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

/** 发给模型前剥掉 @ 符号（名字保留在文字里继续起提示作用） */
export function stripMentions(prompt: string): string {
  return prompt.replace(MENTION_RE, '$1');
}

async function loadShot(db: PrismaClient, shotId: string) {
  const shot = await db.shot.findUnique({
    where: { id: shotId },
    include: { storyboard: true, tags: { include: { tag: true } } },
  });
  if (!shot) throw notFound('镜头');
  return shot;
}

/** GENERATE_IMAGE / kind=keyframe：执行时实时解析绑定作参考图与血缘 parent */
function makeKeyframeExecutor(gens: GenerationGens) {
  return async (
    ctx: Parameters<JobExecutor>[0],
    input: z.infer<typeof KeyframeInputSchema>,
  ): ReturnType<JobExecutor> => {
    const { db, job, updateProgress } = ctx;
    const shot = await loadShot(db, input.shotId);
    const episodeId = shot.storyboard.episodeId;
    const modelCfg = await resolveModelCfg(db, input.modelConfigId);
    await updateProgress(10);

    const rawPrompt = shot.imagePrompt || shot.sourceText;
    const mentions = parseMentions(rawPrompt);
    const resolved: Array<{ assetId: string; note: string; isScene: boolean }> = [];

    if (mentions.length > 0) {
      // 【@ 显式指定】提示词含 @标签名 时，参考图完全由 @ 决定（顺序=@ 出现顺序），
      // 不再自动携带镜头标签；显式指定采取严格校验：标签不存在/没图直接报错。
      const projectTags = await db.tag.findMany({ where: { projectId: job.projectId } });
      const byName = new Map(projectTags.map((t) => [t.name, t]));
      for (const name of mentions) {
        const tag = byName.get(name);
        if (!tag) throw badRequest(`@ 指定的标签「${name}」不存在（设计页可查看全部标签）`);
        const assetId = (await resolveBinding(db, episodeId, tag.id, shot.id)) ?? tag.canonicalAssetId;
        if (!assetId) throw badRequest(`@ 指定的标签「${name}」还没有设计图，请先在设计页生成或上传`);
        if (resolved.some((r) => r.assetId === assetId)) continue;
        const desc = tag.description ? `，${tag.description.slice(0, 60)}` : '';
        resolved.push({
          assetId,
          note: `${name}（${TAG_TYPE_LABEL[tag.type] ?? tag.type}${desc}，@指定）`,
          isScene: tag.type === 'SCENE',
        });
      }
    } else {
      // 【自动策略】逐标签实时解析绑定（Bug6 防复发），未绑定回落默认设计图（canonical）。
      // 实测结论（Seedream 4.0 多参考注意力有限）：只送角色图时形象稳定，掺入场景图会稀释
      // 角色特征——因此角色/道具优先，场景参考只在纯空镜时才送。
      const orderedTags = [...shot.tags].sort(
        (a, b) => (TAG_TYPE_ORDER[a.tag.type] ?? 9) - (TAG_TYPE_ORDER[b.tag.type] ?? 9),
      );
      for (const shotTag of orderedTags) {
        const assetId =
          (await resolveBinding(db, episodeId, shotTag.tagId, shot.id)) ??
          shotTag.tag.canonicalAssetId;
        if (assetId) {
          // 标签描述（如"卡通小猴子"）一并写入——只有参考图而不点明形象时，模型容易画成默认人形
          const desc = shotTag.tag.description ? `，${shotTag.tag.description.slice(0, 60)}` : '';
          resolved.push({
            assetId,
            note: `${shotTag.tag.name}（${TAG_TYPE_LABEL[shotTag.tag.type] ?? shotTag.tag.type}${desc}）`,
            isScene: shotTag.tag.type === 'SCENE',
          });
        }
      }
    }

    const characterRefs = resolved.filter((r) => !r.isScene);
    // @ 显式指定尊重用户选择（含场景图也照发）；自动策略下才做角色优先裁剪
    const chosen = mentions.length > 0 ? resolved : characterRefs.length > 0 ? characterRefs : resolved;
    const boundAssetIds = chosen.map((r) => r.assetId);
    const refTagNotes = chosen.map((r, i) => `参考图${i + 1}：${r.note}`);
    const boundAssets = await db.asset.findMany({ where: { id: { in: boundAssetIds } } });
    const byId = new Map(boundAssets.map((a) => [a.id, a]));
    const refUris = boundAssetIds.map((id) => byId.get(id)?.uri).filter((u): u is string => !!u);

    // 一致性说明放在提示词【开头】（模型对前部 token 权重更高），并硬性禁止角色人格化；
    // @ 符号发给模型前剥掉（名字保留）
    const basePrompt = stripMentions(rawPrompt);
    const prompt =
      refTagNotes.length > 0
        ? `【形象一致性】${refTagNotes.join('；')}。角色的物种与形态严格按参考图，严禁把动物/机器人角色画成人类。\n${basePrompt}`
        : basePrompt;
    const file = allocFilePath(job.projectId, 'png');
    await gens.imageGen({ prompt, refUris, outPath: file.absPath, modelCfg });
    await updateProgress(70);

    const asset = await createAsset(db, {
      projectId: job.projectId,
      type: 'IMAGE',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'image/png',
      sizeBytes: fileSize(file.absPath),
      jobId: job.id,
      parentIds: boundAssetIds,
      // 生成透明度：实际生效的完整提示词与参考图清单可查（区别于镜头上存储的 imagePrompt）
      meta: { effectivePrompt: prompt.slice(0, 2000), refImages: refTagNotes },
    });
    // 图片缩略图直接复用原图 uri（createAsset 不收 thumbUri，落库后补写）
    await db.asset.update({ where: { id: asset.id }, data: { thumbUri: file.uri } });

    const take = await db.take.create({
      data: { shotId: shot.id, slot: 'KEYFRAME', assetId: asset.id, jobId: job.id },
    });
    // 抽卡语义：首个 take 自动 selected，重抽不动已有指针
    if (!shot.keyframeSelectedTakeId) {
      await db.shot.update({ where: { id: shot.id }, data: { keyframeSelectedTakeId: take.id } });
    }
    // 仅当原本 stale 才清除，避免无意义的溯源记录
    if (shot.keyframeStale) await clearStale(db, shot.id, 'KEYFRAME', 'regenerated');
    await updateProgress(95);
    return { outputAssetIds: [asset.id], output: { takeId: take.id } };
  };
}

/** GENERATE_IMAGE / kind=design：给标签生成候选设计图（TagDesign 直接落库，不依赖 design 模块） */
function makeDesignExecutor(gens: GenerationGens) {
  return async (
    ctx: Parameters<JobExecutor>[0],
    input: z.infer<typeof DesignInputSchema>,
  ): ReturnType<JobExecutor> => {
    const { db, job, updateProgress } = ctx;
    const tag = await db.tag.findUnique({
      where: { id: input.tagId },
      include: { canonicalAsset: true },
    });
    if (!tag) throw notFound('标签');
    const modelCfg = await resolveModelCfg(db, input.modelConfigId);
    await updateProgress(10);

    const refUris = tag.canonicalAsset ? [tag.canonicalAsset.uri] : [];
    const file = allocFilePath(job.projectId, 'png');
    await gens.imageGen({ prompt: input.prompt, refUris, outPath: file.absPath, modelCfg });
    await updateProgress(70);

    const asset = await createAsset(db, {
      projectId: job.projectId,
      type: 'IMAGE',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'image/png',
      sizeBytes: fileSize(file.absPath),
      jobId: job.id,
    });
    await db.asset.update({ where: { id: asset.id }, data: { thumbUri: file.uri } });

    const design = await db.tagDesign.create({ data: { tagId: tag.id, assetId: asset.id } });
    // 标签还没有默认参考图时，首张设计图自动设为 canonical
    if (!tag.canonicalAssetId) {
      await db.tag.update({ where: { id: tag.id }, data: { canonicalAssetId: asset.id } });
    }
    await updateProgress(95);
    return { outputAssetIds: [asset.id], output: { designId: design.id } };
  };
}

/**
 * 衔接组（v2 §5）：抽取【前一段】（同 storyboardId + groupId、groupIndex-1）selected VIDEO take
 * 的尾帧，存为 FRAME 资产（source=EXTRACTED，血缘指向前段视频），供本段作首帧。
 */
async function extractPrevSegmentTailFrame(
  db: PrismaClient,
  projectId: string,
  jobId: string,
  shot: { storyboardId: string; groupId: string | null; groupIndex: number | null },
) {
  const prev = await db.shot.findFirst({
    where: {
      storyboardId: shot.storyboardId,
      groupId: shot.groupId,
      groupIndex: (shot.groupIndex ?? 0) - 1,
    },
  });
  const prevTake = prev?.videoSelectedTakeId
    ? await db.take.findUnique({
        where: { id: prev.videoSelectedTakeId },
        include: { asset: true },
      })
    : null;
  if (!prevTake) throw badRequest('衔接组需按顺序生成：请先完成上一段');

  const videoAbs = uriToAbsPath(prevTake.asset.uri);
  // 尾帧时间点：实测时长 - 100ms（资产落库时已存实测时长，缺失则现场 probe 兜底）
  const actualMs = prevTake.asset.durationMs ?? (await probeDurationMs(videoAbs));
  const file = allocFilePath(projectId, 'png');
  await extractFrame({ videoPath: videoAbs, timeMs: Math.max(0, actualMs - 100), outPath: file.absPath });

  const frameAsset = await createAsset(db, {
    projectId,
    type: 'FRAME',
    source: 'EXTRACTED',
    uri: file.uri,
    mime: 'image/png',
    sizeBytes: fileSize(file.absPath),
    jobId,
    parentIds: [prevTake.assetId],
  });
  await db.asset.update({ where: { id: frameAsset.id }, data: { thumbUri: file.uri } });
  return frameAsset;
}

/** GENERATE_VIDEO：以选定关键图为首帧生成片段（衔接组段 1..N-1 改用上一段尾帧），实测时长 + 抽帧缩略图 */
function makeVideoExecutor(gens: GenerationGens): JobExecutor {
  return async (ctx) => {
    const { db, job, updateProgress } = ctx;
    const input = VideoInputSchema.parse(parseJson<unknown>(job.inputJson, {}));
    const shot = await loadShot(db, input.shotId);

    // 首帧来源：组内非首段 → 上一段选定视频的尾帧（v2 §5 强制串行）；否则 → 选定关键图（原逻辑）
    let firstFrameUri: string;
    let firstFrameParentIds: string[];
    if (shot.groupId != null && (shot.groupIndex ?? 0) > 0) {
      const frameAsset = await extractPrevSegmentTailFrame(db, job.projectId, job.id, shot);
      firstFrameUri = frameAsset.uri;
      firstFrameParentIds = [frameAsset.id];
    } else {
      if (!shot.keyframeSelectedTakeId) throw badRequest('请先生成并选定关键图');
      const keyframeTake = await db.take.findUnique({
        where: { id: shot.keyframeSelectedTakeId },
        include: { asset: true },
      });
      if (!keyframeTake) throw notFound('选定的关键图 take');
      firstFrameUri = keyframeTake.asset.uri;
      firstFrameParentIds = [keyframeTake.assetId];
    }
    const modelCfg = await resolveModelCfg(db, input.modelConfigId);
    await updateProgress(10);

    // 时长链路（v2 §3）：配音锁定时长优先，未锁定用计划时长
    const durationMs = shot.durationLockedMs ?? shot.durationPlannedMs;
    const prompt = shot.videoPrompt || shot.sourceText;
    const file = allocFilePath(job.projectId, 'mp4');
    await gens.videoGen({
      prompt,
      firstFrameUri,
      durationMs,
      outPath: file.absPath,
      modelCfg,
      onProgress: updateProgress,
    });
    await updateProgress(70);

    // 实测时长（生成模型不保证精确出片时长），并抽帧作缩略图
    const actualMs = await probeDurationMs(file.absPath);
    const thumbFile = allocFilePath(job.projectId, 'png');
    await extractFrame({
      videoPath: file.absPath,
      timeMs: Math.min(500, Math.floor(actualMs / 2)),
      outPath: thumbFile.absPath,
    });

    const asset = await createAsset(db, {
      projectId: job.projectId,
      type: 'VIDEO',
      source: 'GENERATED',
      uri: file.uri,
      mime: 'video/mp4',
      sizeBytes: fileSize(file.absPath),
      durationMs: actualMs,
      jobId: job.id,
      parentIds: firstFrameParentIds,
    });
    await db.asset.update({ where: { id: asset.id }, data: { thumbUri: thumbFile.uri } });

    const take = await db.take.create({
      data: { shotId: shot.id, slot: 'VIDEO', assetId: asset.id, jobId: job.id },
    });
    if (!shot.videoSelectedTakeId) {
      await db.shot.update({ where: { id: shot.id }, data: { videoSelectedTakeId: take.id } });
    }
    if (shot.videoStale) await clearStale(db, shot.id, 'VIDEO', 'regenerated');
    await updateProgress(95);
    return { outputAssetIds: [asset.id], output: { takeId: take.id } };
  };
}

/** 行间静音间隔（重算镜头配音总时长用） */
export const DUBBING_GAP_MS = 300;

/** GENERATE_TTS：单句配音生成 + 镜头时长链路重算（任何一步失败把行置 FAILED 再抛出） */
function makeTtsExecutor(gens: GenerationGens): JobExecutor {
  return async (ctx) => {
    const { db, job, updateProgress } = ctx;
    const input = TtsInputSchema.parse(parseJson<unknown>(job.inputJson, {}));
    const line = await db.dubbingLine.findUnique({
      where: { id: input.dubbingLineId },
      include: { dialogueLine: true, voiceProfile: true },
    });
    if (!line) throw notFound('配音行');

    try {
      // DubbingLine 无独立文本列（见 schema），文本一律取关联对白行
      const text = line.dialogueLine?.text;
      if (!text) throw badRequest('配音行没有关联的对白文本');
      const modelCfg = await resolveModelCfg(db, input.modelConfigId);
      await updateProgress(10);

      const file = allocFilePath(job.projectId, 'wav');
      await gens.ttsGen({
        text,
        speed: line.speed,
        voiceSeed: line.voiceProfileId ?? 'narrator',
        outPath: file.absPath,
        modelCfg,
      });
      await updateProgress(60);

      const durationMs = await probeDurationMs(file.absPath);
      const asset = await createAsset(db, {
        projectId: job.projectId,
        type: 'AUDIO',
        source: 'GENERATED',
        uri: file.uri,
        mime: 'audio/wav',
        sizeBytes: fileSize(file.absPath),
        durationMs,
        jobId: job.id,
      });
      await db.dubbingLine.update({
        where: { id: line.id },
        data: { status: 'READY', durationMs, audioAssetId: asset.id },
      });
      await updateProgress(80);

      // 时长链路（v2 §3）：全部 READY 行时长之和 + (n-1) 个行间间隔 → 锁定镜头时长
      const readyLines = await db.dubbingLine.findMany({
        where: { shotId: line.shotId, status: 'READY' },
      });
      const totalMs =
        readyLines.reduce((sum, l) => sum + (l.durationMs ?? 0), 0) +
        Math.max(0, readyLines.length - 1) * DUBBING_GAP_MS;
      await onDubbingDurationChanged(db, line.shotId, totalMs);

      return { outputAssetIds: [asset.id], output: { dubbingLineId: line.id, durationMs } };
    } catch (err) {
      // 失败落状态供配音页展示，再交给 worker 走重试/终态逻辑
      await db.dubbingLine.update({ where: { id: line.id }, data: { status: 'FAILED' } });
      throw err;
    }
  };
}

/** 统一入口：集成阶段（app 启动）调用一次；测试可注入假 Gen */
export function registerGenerationExecutors(gens: GenerationGens): void {
  const keyframeExec = makeKeyframeExecutor(gens);
  const designExec = makeDesignExecutor(gens);

  // GENERATE_IMAGE 按 input.kind 分派：keyframe（镜头关键图）/ design（标签设计图）
  registerExecutor('GENERATE_IMAGE', async (ctx) => {
    const input = ImageInputSchema.parse(parseJson<unknown>(ctx.job.inputJson, {}));
    return input.kind === 'keyframe' ? keyframeExec(ctx, input) : designExec(ctx, input);
  });
  registerExecutor('GENERATE_VIDEO', makeVideoExecutor(gens));
  registerExecutor('GENERATE_TTS', makeTtsExecutor(gens));
}
