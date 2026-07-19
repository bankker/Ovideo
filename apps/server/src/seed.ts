import 'dotenv/config';
import { db } from './lib/db.js';
import { toJson } from './lib/json.js';

/** 幂等种子：已有数据则跳过。演示项目 + DeepSeek 厂商模板（填 key 后启用）。
 * 【无 Mock】平台不预置任何 Mock 厂商——用管理后台「一键接入」贴 Key 即可开始。 */
async function main() {
  const existing = await db.providerConfig.count();
  if (existing > 0) {
    console.log('[seed] 已有数据，跳过');
    return;
  }

  await db.providerConfig.create({
    data: {
      name: 'DeepSeek',
      vendor: 'deepseek',
      category: 'TEXT',
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      enabled: false, // 填入 apiKey 后在后台启用
      models: {
        create: [
          {
            key: 'deepseek-chat',
            label: 'DeepSeek Chat',
            modality: 'text',
            capabilityJson: toJson({ modality: 'text', input: ['prompt'] }),
            enabled: true,
          },
        ],
      },
    },
  });

  const project = await db.project.create({
    data: {
      name: '示例项目 · 小悟小空',
      description: '演示用：Wukong AICRM 动画短片（来自需求讲解视频中的示例剧本）',
    },
  });
  const episode = await db.episode.create({
    data: { projectId: project.id, title: '第 1 集', sortOrder: 1 },
  });
  await db.scriptDraft.create({
    data: {
      episodeId: episode.id,
      title: '主剧本',
      isMain: true,
      content: [
        '小悟小空特别篇——Wukong AICRM 动画短片剧本（约60秒）',
        '',
        '场景一：办公室内，白天。',
        '小悟趴在堆满报表的办公桌前，蓬头垢面，黑眼圈深重，对着电脑疯狂打字。屏幕上是密密麻麻的输入框，电脑主机嗡嗡作响。',
        '小空站在一旁，歪头疑惑地看着。',
        '小空：小悟啊，你在干什么呀？',
        '小悟：唉，刚拜访完客户还没录入信息，快忘记细节了！又丢新客户，昨天忘记录入还被部门通报了。',
        '',
        '场景二：办公室内，片刻之后。',
        '小悟转身继续敲键盘，报警声更响。小空不慌不忙，亮出平板电脑，屏幕上显示着 Wukong AICRM。',
        '小空：工作，怎么能这么累呢？让 AI 来帮你。',
        '',
        '场景三：同一办公室，明亮清新。',
        '小悟的桌面不再杂乱，电脑屏幕清爽干净，他舒服地靠在椅背上，端着咖啡，两人一起看着镜头微笑。',
        '小悟：全搞定啦！Wukong AICRM，省时省力，神器也！',
      ].join('\n'),
    },
  });

  console.log(`[seed] 完成：项目「${project.name}」/ ${episode.title} / 主剧本 + DeepSeek 厂商模板（用管理后台「一键接入」贴 Key 后即可生成）`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
