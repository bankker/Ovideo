import type { PrismaClient } from '@prisma/client';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseJson } from '../../lib/json.js';
import type { TextGenFn } from './generate.js';

/** 中文口播速率经验值：约每秒 4 字。用来把"目标时长"翻译成 LLM 能照做的字数约束 */
const CHARS_PER_SEC = 4;
/** 一个场景大致覆盖 12 秒成片，据此估场景数（再夹取到 2~12，避免极短/极长时长退化） */
const SEC_PER_SCENE = 12;

export interface BuildScriptPromptInput {
  brief: string;
  durationSec: number;
  /** 风格/受众补充，用户可留空 */
  style?: string;
  /** 项目级画风设定（Project.stylePrompt），有则并入风格约束保持全项目统一 */
  stylePrompt?: string;
}

/**
 * 一句话创意 → 剧本正文的提示词。
 * 【硬约束】产出必须能被 buildStoryboardPrompt 的三步生成良好拆分，
 * 所以这里逐条把"场景标题行 / 角色名：台词 / 角色名全剧统一"写死进提示词——
 * 这三点正是拆分镜时建场景标签、抽对白、建角色标签的依据，缺一条下游就会散架。
 */
export function buildScriptPrompt(input: BuildScriptPromptInput): string {
  const { brief, durationSec, style, stylePrompt } = input;
  const totalChars = durationSec * CHARS_PER_SEC;
  const sceneCount = Math.max(2, Math.min(12, Math.round(durationSec / SEC_PER_SCENE)));

  return [
    '你是专业的漫剧（动画短剧）编剧。请根据下面的创意，直接写出一集完整的剧本正文。',
    '',
    '【输出格式】（硬规则，违反会导致后续自动拆分镜失败）',
    '1. 只输出剧本正文本身，不要任何开场白、解释、点评、标题、markdown 代码块或编号列表；',
    `2. 按场景分段，每个场景以独立一行的场景标题开头，格式严格为「场景N：地点，时间。」（例："场景一：办公室内，白天。"）；`,
    '3. 场景标题之后先写动作/环境描述（第三人称陈述句，交代人物在做什么、环境什么样），再写对白；',
    '4. 对白格式严格为「角色名：台词」，一行一句，冒号用中文全角「：」；',
    '5. 旁白也写成对白形式，说话人一律写「旁白」；',
    '6. 场景之间空一行分隔。',
    '',
    '【角色命名】（硬规则，角色名是全剧形象一致性的锚点）',
    '7. 角色名简短，不超过 6 个字，且全剧统一——同一个角色从头到尾用同一个称呼，绝不换成外号、职称或代词；',
    '8. 【严禁】把角色名写成英文或拼音（"小悟"绝不能写成 Xiaowu / Little Wu）；',
    '9. 角色数量控制在 2~4 个，人多了短片讲不清。',
    '',
    '【篇幅控制】',
    `10. 目标成片时长约 ${durationSec} 秒。中文口播约每秒 ${CHARS_PER_SEC} 字，因此正文对白总字数约 ${totalChars} 字（可上下浮动 20%），不要写超；`,
    `11. 场景数约 ${sceneCount} 个；`,
    '12. 动作/环境描述精炼，服务于画面即可，不写内心独白式的长段文学描写。',
    '',
    '【内容要求】',
    '13. 这是漫剧（动画短剧），角色可以是动物、机器人等非人形象，设定放得开；',
    '14. 开头 3 秒内必须抓住注意力，结尾要有记忆点（反转、金句或情绪落点）；',
    '15. 情节完整自洽，不要留待续。',
    // 用 null 而非 '' 标记"该条不存在"，否则会连同上面的空行分隔一起被过滤掉
    stylePrompt
      ? `16. 画面风格：本项目统一为「${stylePrompt}」，场景与人物设定需与该风格相符。`
      : null,
    style ? `17. 风格与受众补充要求：${style}` : null,
    '',
    '【创意】',
    brief,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

/** 与 job 模块的 JobExecutor 结构兼容（不 import，按结构类型解耦，同 generate.ts） */
export interface ScriptWriterCtx {
  db: PrismaClient;
  job: { inputJson: string };
  updateProgress: (p: number) => Promise<void>;
}

interface GenerateScriptInput {
  draftId?: string;
  brief?: string;
  durationSec?: number;
  style?: string;
}

/** 模型偶尔仍会套一层 ``` 围栏，剥掉后再落库，免得用户在编辑器里看到反引号 */
function stripFence(raw: string): string {
  const fenced = raw.match(/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)```\s*$/);
  return (fenced ? fenced[1] : raw).trim();
}

/**
 * GENERATE_SCRIPT 的 Job 执行器工厂。textGen 由集成阶段注入（与三步生成同一套调度策略）。
 * 【付费产物零删除】生成失败时草稿原样保留（哪怕内容还是空的）——
 * 用户可以在它上面自己动手写，或直接重试，绝不因为一次调用失败就抹掉一行记录。
 */
export function makeGenerateScript({ textGen }: { textGen: TextGenFn }) {
  return async function generateScript(
    ctx: ScriptWriterCtx,
  ): Promise<{ output: { draftId: string; charCount: number } }> {
    const { db, job, updateProgress } = ctx;
    const input = parseJson<GenerateScriptInput>(job.inputJson, {});
    if (!input.draftId) throw badRequest('任务输入缺少 draftId');
    if (!input.brief) throw badRequest('任务输入缺少 brief');

    const draft = await db.scriptDraft.findUnique({
      where: { id: input.draftId },
      include: { episode: true },
    });
    if (!draft) throw notFound('剧本稿');

    const project = await db.project.findUnique({ where: { id: draft.episode.projectId } });
    const prompt = buildScriptPrompt({
      brief: input.brief,
      durationSec: input.durationSec ?? 60,
      style: input.style,
      stylePrompt: project?.stylePrompt ?? '',
    });
    await updateProgress(20);

    const content = stripFence(await textGen(prompt));
    if (!content) throw badRequest('文本模型返回了空剧本，请重试或更换文本模型');

    await db.scriptDraft.update({ where: { id: draft.id }, data: { content } });
    await updateProgress(90);

    return { output: { draftId: draft.id, charCount: content.length } };
  };
}
