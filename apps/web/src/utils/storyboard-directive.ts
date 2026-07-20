// 导演方案 → 一段中文导演说明。
//
// 【为什么产出的是自然语言而不是结构化字段】三步生成的服务端接口只接受剧本正文与标签词表，
// 拆镜规则全部写在提示词里。若为每个参数新开一个接口字段，服务端要为每个字段
// 各写一段提示词拼装逻辑，参数一多就散架。把方案先在前端收敛成一段"导演要求"，
// 服务端只需把它整段插进提示词——新增参数不再需要动服务端。
//
// 【为什么单独成文件】它是纯函数，可以被单测锁死；拼在弹窗组件里就只能靠肉眼看。

/** 三种拆镜风格。avgShotSec 是该风格的基准单镜长度，用于估算镜头数 */
export const DIRECTOR_PLANS = [
  {
    key: 'steady',
    name: '稳健叙事',
    summary: '中景与正反打为主，镜头数较少',
    /** 写进导演说明的那句话，比 summary 更完整 */
    directive: '中景与正反打为主，保证人物关系交代清楚，少用花哨景别',
    avgShotSec: 5,
  },
  {
    key: 'commercial',
    name: '商业快剪',
    summary: '特写与插入镜头多，切换快',
    directive: '特写与插入镜头多，切换节奏快，多用细节镜头制造信息密度',
    avgShotSec: 3,
  },
  {
    key: 'anime',
    name: '动漫戏剧',
    summary: '构图夸张，增加人物反应镜头',
    directive: '构图夸张，角度倾斜，增加人物反应镜头与情绪特写',
    avgShotSec: 4,
  },
] as const;

export type DirectorPlanKey = (typeof DIRECTOR_PLANS)[number]['key'];

export type Pace = 'slow' | 'medium' | 'fast';
export type CameraIntensity = 'weak' | 'medium' | 'strong';
export type Priority = 'dialogue' | 'visual';

/** 节奏对基准单镜长度的缩放：慢 = 镜头更长更少，快 = 更短更多 */
const PACE_FACTOR: Record<Pace, number> = { slow: 1.25, medium: 1, fast: 0.75 };
const PACE_LABEL: Record<Pace, string> = { slow: '偏慢', medium: '中等', fast: '偏快' };
const CAMERA_LABEL: Record<CameraIntensity, string> = {
  weak: '弱（以固定机位为主）',
  medium: '中等',
  strong: '强（多用推拉摇跟）',
};

export const PACE_OPTIONS: Array<{ value: Pace; label: string }> = [
  { value: 'slow', label: '慢' },
  { value: 'medium', label: '中' },
  { value: 'fast', label: '快' },
];

export const CAMERA_OPTIONS: Array<{ value: CameraIntensity; label: string }> = [
  { value: 'weak', label: '弱' },
  { value: 'medium', label: '中' },
  { value: 'strong', label: '强' },
];

export function planOf(key: DirectorPlanKey) {
  // key 来自本模块自己的常量表，找不到属于编程错误，回落到第一项而不是抛错——
  // 一个弹窗不该因为方案 key 拼错就白屏
  return DIRECTOR_PLANS.find((p) => p.key === key) ?? DIRECTOR_PLANS[0];
}

/** 该方案在给定总时长与节奏下的建议镜头数（至少 1 个） */
export function suggestShotCount(
  plan: DirectorPlanKey,
  targetDurationSec: number,
  pace: Pace,
): number {
  const base = planOf(plan).avgShotSec * PACE_FACTOR[pace];
  if (base <= 0 || targetDurationSec <= 0) return 1;
  return Math.max(1, Math.round(targetDurationSec / base));
}

/** 平均单镜长度（秒，一位小数）；镜头数为 0 时返回 0 而不是 Infinity */
export function averageShotSec(targetDurationSec: number, shotCount: number): number {
  if (shotCount <= 0) return 0;
  return Math.round((targetDurationSec / shotCount) * 10) / 10;
}

export interface DirectorSettings {
  plan: DirectorPlanKey;
  targetDurationSec: number;
  pace: Pace;
  shotCount: number;
  camera: CameraIntensity;
  priority: Priority;
  autoEstablishing: boolean;
  autoReaction: boolean;
  /** 画面比例，如 '9:16'；空串表示不指定 */
  aspectRatio: string;
}

/**
 * 拼成一段导演说明。句子之间用句号连接，整段作为提示词里的「导演要求」插入。
 * 【为什么每一项都落成中文句子】模型对"pace=fast"这类键值对的遵从度远不如自然语言，
 * 而这段文字最终是和其余中文规则并排放进同一个提示词里的。
 */
export function buildDirective(s: DirectorSettings): string {
  const p = planOf(s.plan);
  const avg = averageShotSec(s.targetDurationSec, s.shotCount);
  const parts: string[] = [
    `拆镜风格：${p.name}（${p.directive}）`,
    `目标总时长约 ${s.targetDurationSec} 秒，建议 ${s.shotCount} 个镜头，平均每镜约 ${avg} 秒`,
    `整体节奏${PACE_LABEL[s.pace]}`,
    `运镜强度${CAMERA_LABEL[s.camera]}`,
    s.priority === 'dialogue'
      ? '优先保证对白完整，不要为了画面切碎台词'
      : '优先保证画面表现力，台词可以适当分配到多个镜头的画外',
  ];

  // 空镜与反应镜头合成一句，避免"自动补充空镜。自动补充反应镜头。"这种机械重复
  const extras = [
    s.autoEstablishing ? '空镜（交代环境的无人镜头）' : '',
    s.autoReaction ? '人物反应镜头' : '',
  ].filter((x) => x !== '');
  if (extras.length > 0) parts.push(`在合适的位置自动补充${extras.join('与')}`);
  else parts.push('不要额外添加空镜或反应镜头，只拆剧本里实际写到的内容');

  if (s.aspectRatio !== '') {
    parts.push(`成片画面比例为 ${s.aspectRatio}，构图请按该比例设计`);
  }

  return `${parts.join('。')}。`;
}
