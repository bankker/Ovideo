// 启用视觉评审模型（自动收敛 agent 的质检模型）。幂等，可重复运行。
// 选型说明：火山方舟的视觉端点（doubao-vision-*）需单独开通，未开通时调用返回 404；
// 百炼的 qwen-vl-max 随文本 key 一起可用，故默认用它。
import { PrismaClient } from '@prisma/client';

const db = new PrismaClient();
const TARGET = {
  providerNameLike: '百炼',
  key: 'qwen-vl-max',
  label: '通义千问 VL Max（视觉理解）',
};

const provider = await db.providerConfig.findFirst({
  where: { name: { contains: TARGET.providerNameLike } },
});
if (!provider) {
  console.error(`未找到厂商（名称含「${TARGET.providerNameLike}」），请先在管理后台配置`);
  process.exit(1);
}

const data = {
  enabled: true,
  modality: 'vision',
  label: TARGET.label,
  capabilityJson: JSON.stringify({ modality: 'vision', input: ['prompt', 'image'] }),
};
const existing = await db.modelConfig.findFirst({
  where: { providerConfigId: provider.id, key: TARGET.key },
});
const model = existing
  ? await db.modelConfig.update({ where: { id: existing.id }, data })
  : await db.modelConfig.create({
      data: { ...data, providerConfigId: provider.id, key: TARGET.key, sortOrder: 0 },
    });

console.log(`视觉评审模型已就绪：${model.label}（${provider.name} / ${model.key}）`);
await db.$disconnect();
