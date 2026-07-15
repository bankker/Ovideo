/** OpenAI 兼容 chat 消息（M1 仅需三种角色） */
export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

/** 文本生成函数契约：其他模块（如三步生成）以此类型注入，不直接依赖本模块 */
export type TextGenFn = (prompt: string) => Promise<string>;
