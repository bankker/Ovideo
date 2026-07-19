// Dubbing 配音模块服务（M2）：对白 → 配音行同步 + 行编辑。
// 铁律：音频资产从不物理删除（付费产物保护）——speed 变更只把 status 打回 PENDING，旧音频保留。
// 跨模块约定：本模块不 import 其他 M2 新模块；TTS 生成经 Job（input.kind='dubbing'）交给 generation 执行器。
import type { Prisma, PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';

/** 路由统一返回的行明细形状：对白来源 + 音频资产 + 声音档案 */
export type DubbingLineDetail = Prisma.DubbingLineGetPayload<{
  include: { dialogueLine: true; audioAsset: true; voiceProfile: true };
}>;

const LINE_INCLUDE = { dialogueLine: true, audioAsset: true, voiceProfile: true } as const;

/** 行排序：对白行按对白 sortOrder；自由行（无对白来源）排最后；同序按创建时间稳定 */
function sortLines(lines: DubbingLineDetail[]): DubbingLineDetail[] {
  return [...lines].sort((a, b) => {
    const ao = a.dialogueLine?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    const bo = b.dialogueLine?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    if (ao !== bo) return ao - bo;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

export async function listDubbingLines(
  db: PrismaClient,
  shotId: string,
): Promise<DubbingLineDetail[]> {
  const shot = await db.shot.findUnique({ where: { id: shotId } });
  if (!shot) throw notFound('镜头');
  const lines = await db.dubbingLine.findMany({ where: { shotId }, include: LINE_INCLUDE });
  return sortLines(lines);
}

/**
 * 说话人标签 → 项目 VoiceProfile：按 tagId 找，没有则自动创建（名字 = 标签名）。
 * 说话人标签已被删除时返回 null（该行按旁白处理，不阻塞同步）。
 */
async function ensureVoiceProfile(
  db: PrismaClient,
  projectId: string,
  tagId: string,
): Promise<string | null> {
  const found = await db.voiceProfile.findFirst({ where: { projectId, tagId } });
  if (found) return found.id;
  const tag = await db.tag.findUnique({ where: { id: tagId } });
  if (!tag) return null;
  const created = await db.voiceProfile.create({
    data: { projectId, tagId, name: tag.name },
  });
  return created.id;
}

/**
 * 幂等同步：为镜头的每条 DialogueLine 建 DubbingLine。
 * - dialogueLineId 已存在配音行的对白跳过（幂等；已生成的音频与状态不被打扰）；
 * - 说话人行（speakerTagId 非空）关联项目 VoiceProfile（无则自动创建）；
 * - 旁白/无说话人行 voiceProfileId 留 null。
 * 返回该镜头全部配音行（含 include，按对白 sortOrder）。
 */
export async function syncDubbingLines(
  db: PrismaClient,
  shotId: string,
): Promise<DubbingLineDetail[]> {
  const shot = await db.shot.findUnique({
    where: { id: shotId },
    include: {
      dialogue: { orderBy: { sortOrder: 'asc' } },
      storyboard: { include: { episode: true } },
    },
  });
  if (!shot) throw notFound('镜头');
  const projectId = shot.storyboard.episode.projectId;

  const existing = await db.dubbingLine.findMany({ where: { shotId } });
  const linked = new Set(
    existing.map((l) => l.dialogueLineId).filter((v): v is string => v !== null),
  );

  // 同一说话人在本次同步内只解析/创建一次
  const profileCache = new Map<string, string | null>();
  for (const dialogue of shot.dialogue) {
    if (linked.has(dialogue.id)) continue;
    let voiceProfileId: string | null = null;
    if (dialogue.speakerTagId) {
      if (!profileCache.has(dialogue.speakerTagId)) {
        profileCache.set(
          dialogue.speakerTagId,
          await ensureVoiceProfile(db, projectId, dialogue.speakerTagId),
        );
      }
      voiceProfileId = profileCache.get(dialogue.speakerTagId) ?? null;
    }
    await db.dubbingLine.create({
      data: { shotId, dialogueLineId: dialogue.id, voiceProfileId },
    });
  }
  return listDubbingLines(db, shotId);
}

export interface UpdateDubbingLineInput {
  /** 语速 0.5~2（路由层 zod 校验范围） */
  speed?: number;
  /** 台词文案：直接改写来源对白（只作用于当前分镜版本的这条对白） */
  text?: string;
}

/**
 * 行编辑：
 * - text：改写来源 DialogueLine.text。文案变了旧音频就对不上，故把行打回 PENDING 等待重新生成；
 *   旧音频资产保留不删（付费产物保护），时长锁定留到重新生成时由 TTS 执行器重算。
 *   无对白来源的自由行没有文本列可写，明确 400 防误用。
 * - speed：值变化才生效——status 回 PENDING（需重新生成），旧音频资产保留不删。
 */
export async function updateDubbingLine(
  db: PrismaClient,
  id: string,
  input: UpdateDubbingLineInput,
): Promise<DubbingLineDetail> {
  const line = await db.dubbingLine.findUnique({ where: { id }, include: LINE_INCLUDE });
  if (!line) throw notFound('配音行');

  let textChanged = false;
  if (input.text !== undefined) {
    if (!line.dialogueLineId || !line.dialogueLine) {
      throw badRequest('该配音行没有对白来源，无法修改文案');
    }
    const next = input.text.trim();
    if (next === '') throw badRequest('台词内容不能为空');
    if (next !== line.dialogueLine.text) {
      await db.dialogueLine.update({ where: { id: line.dialogueLineId }, data: { text: next } });
      textChanged = true;
    }
  }

  const speedChanged = input.speed !== undefined && input.speed !== line.speed;
  if (textChanged || speedChanged) {
    return db.dubbingLine.update({
      where: { id },
      data: {
        ...(speedChanged ? { speed: input.speed } : {}),
        status: 'PENDING',
      },
      include: LINE_INCLUDE,
    });
  }
  // 无实质变化：重查一次保证返回的 dialogueLine 是最新的
  return (await db.dubbingLine.findUnique({ where: { id }, include: LINE_INCLUDE }))!;
}
