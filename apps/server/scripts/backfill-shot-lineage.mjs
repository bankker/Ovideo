// 存量 Shot 的 lineageId 回填。
// 背景：lineageId 引入前建的分镜版本各自独立，同一个逻辑镜头在 v1..vN 之间没有任何关联，
// 导致用户在旧版本上抽的卡在新版本里"消失"。这里按"版本升序 + sortOrder 对位"重建历史关联。
// sortOrder 对位是唯一可用的线索（旧数据没留别的痕迹），reorder 过的分集可能对错——
// 但错关联只是让选择器多列/少列几张历史图，不删任何产物，代价可控。
// 幂等：已有 lineageId 的行一律跳过，可反复执行。
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();

async function main() {
  const episodes = await db.episode.findMany({ select: { id: true, title: true } });
  let totalFilled = 0;

  for (const episode of episodes) {
    const storyboards = await db.storyboard.findMany({
      where: { episodeId: episode.id },
      orderBy: { version: 'asc' },
      include: { shots: { orderBy: { sortOrder: 'asc' } } },
    });
    if (storyboards.length === 0) continue;

    let filled = 0;
    /** 上一版本的 sortOrder → lineageId，供下一版本对位继承 */
    let prevLineageBySort = new Map();

    for (const storyboard of storyboards) {
      const currentLineageBySort = new Map();
      for (const shot of storyboard.shots) {
        // 已回填过的行直接沿用它的 lineage，保证后续版本仍能接上
        const lineageId = shot.lineageId ?? prevLineageBySort.get(shot.sortOrder) ?? shot.id;
        if (!shot.lineageId) {
          await db.shot.update({ where: { id: shot.id }, data: { lineageId } });
          filled += 1;
        }
        currentLineageBySort.set(shot.sortOrder, lineageId);
      }
      prevLineageBySort = currentLineageBySort;
    }

    totalFilled += filled;
    console.log(
      `分集 ${episode.title}（${episode.id}）：${storyboards.length} 个版本，回填 ${filled} 行`,
    );
  }

  console.log(`\n合计回填 ${totalFilled} 行 Shot。`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
