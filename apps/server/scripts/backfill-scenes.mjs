// 存量 Shot 的 Scene 回填。
// 背景：Scene 引入前，"一场戏"被三步生成直接产出成"一个镜头"，故存量数据本就是一场一镜——
// 这里为每个既有 Shot 建一条 Scene 并挂上去，让存量分镜在新的两级模型下也能正常展示，
// 而不是全部落进"未归属场景"的兜底分组。
// 场景标题从 shot.sourceText 的抬头行解析（「场景一：客户会议室，白天。」）；
// 解析不出就退化为首行前 20 字作 title，其余字段留空——宁可字段缺失，不可认错。
// 幂等：已有 sceneId 的行一律跳过，可反复执行。
//
// 运行：apps/server 下 `pnpm exec tsx scripts/backfill-scenes.mjs`
// 必须用 tsx（本仓服务端不产 dist，build 是 --noEmit）：解析逻辑复用 scene-parse.ts 本体，
// 在脚本里另抄一份迟早与线上生成链路解析口径不一致。
import { PrismaClient } from '@prisma/client';
import { parseSceneHeading, fallbackSceneTitle } from '../src/modules/storyboard/scene-parse.js';

const db = new PrismaClient();

/** 从镜头原文里提取场景字段：逐行找抬头，找不到就用兜底标题 */
function sceneFieldsOf(sourceText) {
  const text = sourceText ?? '';
  for (const line of text.split('\n')) {
    const parsed = parseSceneHeading(line);
    // 抬头解析出来但标题为空（如单独一行「场景一：」）不算有效，继续往下找
    if (parsed && parsed.title) return parsed;
  }
  return {
    title: fallbackSceneTitle(text),
    location: '',
    interiorExterior: '',
    timeOfDay: '',
  };
}

async function main() {
  const storyboards = await db.storyboard.findMany({
    select: { id: true, version: true, episodeId: true },
    orderBy: { version: 'asc' },
  });
  let totalScenes = 0;
  let totalShots = 0;

  /**
   * 逻辑镜头 → 场景 lineage 锚点。
   * 存量数据里同一个逻辑镜头靠 Shot.lineageId 串起 v1..vN；若每个版本各开一条场景 lineage，
   * 「同一逻辑场景跨版本关联」的契约当场就断，而回填是一次性的（幂等跳过已补的行），
   * 错了就永久固化。故按 Shot.lineageId 复用锚点——外层已按 version 升序，
   * 首次出现的必是最早版本，锚点方向正确。
   */
  const sceneLineageByShotLineage = new Map();

  for (const storyboard of storyboards) {
    const shots = await db.shot.findMany({
      where: { storyboardId: storyboard.id },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        sortOrder: true,
        sourceText: true,
        sceneId: true,
        lineageId: true,
        durationPlannedMs: true,
        durationLockedMs: true,
      },
    });

    let created = 0;
    // sortOrder 独立于镜头下标递增：跳过的镜头不该在场景序号里留空洞
    let sceneSortOrder = 0;
    for (const shot of shots) {
      if (shot.sceneId) continue; // 幂等
      const fields = sceneFieldsOf(shot.sourceText);
      const scene = await db.scene.create({
        data: {
          storyboardId: storyboard.id,
          sortOrder: sceneSortOrder,
          title: fields.title,
          location: fields.location,
          interiorExterior: fields.interiorExterior,
          timeOfDay: fields.timeOfDay,
          sourceText: shot.sourceText,
          // 一场一镜，场景时长就是这个镜头的时长（锁定优先，同 v2 §3 时长链）
          estimatedDurationMs: shot.durationLockedMs ?? shot.durationPlannedMs,
        },
      });
      // 同一逻辑镜头在更早版本已开过场景 lineage 就复用它，否则本条自开锚
      // （shot.lineageId 为空的存量行退化为自开锚，与其自身的孤立状态一致）
      const shotLineage = shot.lineageId;
      const inherited = shotLineage ? sceneLineageByShotLineage.get(shotLineage) : undefined;
      const sceneLineage = inherited ?? scene.id;
      if (shotLineage && inherited === undefined) {
        sceneLineageByShotLineage.set(shotLineage, sceneLineage);
      }
      await db.scene.update({ where: { id: scene.id }, data: { lineageId: sceneLineage } });
      await db.shot.update({ where: { id: shot.id }, data: { sceneId: scene.id } });
      created += 1;
      sceneSortOrder += 1;
    }

    totalScenes += created;
    totalShots += shots.length;
    if (created > 0) {
      console.log(
        `分镜 v${storyboard.version}（${storyboard.id}）：${shots.length} 个镜头，补 ${created} 条 Scene`,
      );
    }
  }

  console.log(
    `\n合计：扫描 ${storyboards.length} 个分镜版本 / ${totalShots} 个镜头，新建 ${totalScenes} 条 Scene。`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
