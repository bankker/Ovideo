import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Input, Select, Space, Spin, Typography, Upload, message } from 'antd';
import { ReloadOutlined, ThunderboltOutlined, UploadOutlined } from '@ant-design/icons';
import type { CapabilityEntry } from '@ovideo/shared';
import { useJob } from '../../api/workflow-hooks';
import {
  useGenerateScriptDraft,
  useImportScriptDraft,
  type GenerateScriptDraftInput,
} from '../../api/script-hooks';

const { Text, Title } = Typography;

/** 时长档位：与三步生成的镜头拆分粒度匹配，短剧常用 30s~5min */
const DURATION_OPTIONS = [
  { value: 30, label: '30 秒' },
  { value: 60, label: '1 分钟' },
  { value: 120, label: '2 分钟' },
  { value: 180, label: '3 分钟' },
  { value: 300, label: '5 分钟' },
];

/**
 * 剧本生成的常驻失败态。
 * detail 是服务端错误全文（原样呈现，不截断不改写）；
 * payload 是这次失败对应的请求参数快照，「重试」按它原样重发。
 */
interface GenerateFailure {
  detail: string;
  payload: GenerateScriptDraftInput;
}

export interface ScriptStarterProps {
  episodeId: string;
  /** 文本模型清单由页面统一拉取后传入，避免同页重复请求 */
  textModels: CapabilityEntry[];
  textModelId: string | undefined;
  onTextModelChange: (modelConfigId: string | undefined) => void;
  /** 剧本稿就绪（生成完成或导入成功）→ 页面选中它并切回编辑器 */
  onCreated: (draftId: string) => void;
  /**
   * 发起生成时通知页面把入口钉住。
   * 服务端是"先建空稿再入队"，草稿一落库页面就认为"已有剧本稿"，
   * 若不钉住，入口会在提交的瞬间被卸载——进度、轮询、以及用户填的创意一起消失，
   * 看起来就像"根本没调用模型"。
   */
  onGenerationStart: () => void;
}

/**
 * 「从想法开始」创作入口：一句话 → 剧本稿。
 * 生成任务自带 Job 轮询（与页面「三步生成分镜」的 runningJobId 各管各的，
 * 两条链路互不干扰——手工粘贴剧本的既有路径完全不受影响）。
 */
export function ScriptStarter({
  episodeId,
  textModels,
  textModelId,
  onTextModelChange,
  onCreated,
  onGenerationStart,
}: ScriptStarterProps) {
  const qc = useQueryClient();
  const [brief, setBrief] = useState('');
  const [durationSec, setDurationSec] = useState(60);
  const [style, setStyle] = useState('');

  const generate = useGenerateScriptDraft(episodeId);
  const importDraft = useImportScriptDraft(episodeId);

  /** 正在生成的 Job 与它对应的草稿：Job 成功后要把这一稿交回页面 */
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const pendingDraftIdRef = useRef<string | null>(null);
  /** 生成失败的常驻提示（入队失败与 Job FAILED 共用同一份状态） */
  const [failure, setFailure] = useState<GenerateFailure | null>(null);
  /** 最近一次发起用的参数：Job 轮询到 FAILED 时也要能原样重试 */
  const lastPayloadRef = useRef<GenerateScriptDraftInput | null>(null);
  const jobQuery = useJob(runningJobId);
  const job = jobQuery.data;

  useEffect(() => {
    if (!job || job.id !== runningJobId) return;
    const draftId = pendingDraftIdRef.current;
    if (job.status === 'SUCCEEDED') {
      setRunningJobId(null);
      pendingDraftIdRef.current = null;
      setBrief('');
      if (draftId !== null) {
        // 列表里此刻还是入队时那份空稿，必须等重新拉取完成再交给页面，
        // 否则编辑器会载入空正文（草稿 id 没变，内容变了）
        void qc
          .invalidateQueries({ queryKey: ['script-drafts', episodeId] })
          .finally(() => onCreated(draftId));
      }
    } else if (job.status === 'FAILED') {
      // 空草稿保留在列表里（付费产物零删除原则的延伸：用户可自行编辑或重试），
      // 所以这里只报错，不清理任何东西——尤其不清空用户填的创意文本
      const detail = job.error ?? '剧本生成失败，服务端未返回具体原因。';
      message.error(detail);
      const payload = lastPayloadRef.current;
      if (payload !== null) setFailure({ detail, payload });
      setRunningJobId(null);
      pendingDraftIdRef.current = null;
    } else if (job.status === 'CANCELED') {
      message.warning('剧本生成任务已取消');
      setRunningJobId(null);
      pendingDraftIdRef.current = null;
    }
  }, [job, runningJobId, onCreated, qc, episodeId]);

  const generating = generate.isPending || runningJobId !== null;
  const trimmedBrief = brief.trim();

  /** 统一的发起入口：新发起与「重试」共用，保证参数与错误清理逻辑只有一份 */
  const submitGenerate = (payload: GenerateScriptDraftInput) => {
    if (generating) return;
    setFailure(null); // 再次发起 → 清除旧的失败提示
    // 先钉住入口：空稿一落库页面就会认为"已有剧本稿"，不钉住这一屏会当场消失
    onGenerationStart();
    lastPayloadRef.current = payload;
    generate.mutate(payload, {
      onSuccess: (res) => {
        pendingDraftIdRef.current = res.draft.id;
        setRunningJobId(res.job.id);
      },
      onError: (e) => {
        // 入队就失败（400 / 网络断）：同样留下常驻提示，不清空用户填的内容
        const detail = e instanceof Error ? e.message : '剧本生成请求失败。';
        message.error(detail);
        setFailure({ detail, payload });
      },
    });
  };

  const handleGenerate = () => {
    if (trimmedBrief === '' || generating) return;
    const trimmedStyle = style.trim();
    submitGenerate({
      brief: trimmedBrief,
      durationSec,
      ...(trimmedStyle !== '' ? { style: trimmedStyle } : {}),
      ...(textModelId !== undefined ? { modelConfigId: textModelId } : {}),
    });
  };

  const progressText =
    job?.status === 'RUNNING' ? `进度 ${job.progress}%` : '排队中';

  return (
    <Card size="small" style={{ maxWidth: 720, margin: '0 auto', width: '100%' }}>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <div>
          <Title level={5} style={{ marginBottom: 4 }}>
            从一个想法开始
          </Title>
          <Text type="secondary" style={{ fontSize: 12 }}>
            描述你的故事，AI 会写成可直接拆分镜的剧本稿
          </Text>
        </div>

        <Input.TextArea
          value={brief}
          onChange={(e) => setBrief(e.target.value)}
          autoSize={{ minRows: 3, maxRows: 6 }}
          maxLength={2000}
          disabled={generating}
          style={{ fontSize: 15, lineHeight: 1.7 }}
          placeholder="用一句话描述你的故事…例如：一个总把报表搞砸的职场新人，遇到会用 AI 的搭档，三分钟学会用 CRM 提效"
        />

        {/* 次要控件：时长 / 风格 / 文本模型 */}
        <Space wrap style={{ width: '100%' }}>
          <Select
            style={{ width: 120 }}
            value={durationSec}
            onChange={setDurationSec}
            disabled={generating}
            options={DURATION_OPTIONS}
          />
          <Input
            style={{ width: 280 }}
            value={style}
            maxLength={200}
            disabled={generating}
            onChange={(e) => setStyle(e.target.value)}
            placeholder="风格与受众（可选），如：轻松幽默，面向职场新人"
          />
          <Select
            style={{ width: 200 }}
            allowClear
            disabled={generating}
            placeholder="文本模型（自动调度）"
            value={textModelId}
            onChange={(v) => onTextModelChange(v)}
            options={textModels.map((m) => ({
              value: m.modelConfigId,
              label: `${m.label}（${m.providerName}）`,
            }))}
          />
        </Space>

        <Button
          type="primary"
          size="large"
          block
          icon={<ThunderboltOutlined />}
          loading={generating}
          disabled={trimmedBrief === ''}
          onClick={handleGenerate}
        >
          生成剧本
        </Button>

        {/* 生成失败：常驻在发起区域内，直接展示服务端错误全文 + 原参数重试 */}
        {failure !== null && (
          <Alert
            type="error"
            showIcon
            closable
            onClose={() => setFailure(null)}
            message="剧本生成失败"
            description={
              <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13 }}>
                {failure.detail}
              </div>
            }
            action={
              <Button
                size="small"
                danger
                icon={<ReloadOutlined />}
                disabled={generating}
                onClick={() => submitGenerate(failure.payload)}
              >
                重试
              </Button>
            }
          />
        )}

        {generating && (
          <Space size={8}>
            <Spin size="small" />
            <Text type="secondary" style={{ fontSize: 12 }}>
              正在创作剧本…（约 20-40 秒）
              {runningJobId !== null ? `　${progressText}` : ''}
            </Text>
          </Space>
        )}

        {/* 导入既有剧本：与生成并列的第二条入口 */}
        <Space size={8} wrap>
          <Text type="secondary" style={{ fontSize: 12 }}>
            或
          </Text>
          <Upload
            showUploadList={false}
            accept=".txt,.md"
            beforeUpload={(file) => {
              importDraft.mutate(file, {
                onSuccess: (draft) => {
                  message.success('剧本已导入');
                  onCreated(draft.id);
                },
                onError: (e) => message.error(e.message),
              });
              return false; // 走 apiUpload，不用 antd 内置上传
            }}
          >
            <Button size="small" icon={<UploadOutlined />} loading={importDraft.isPending}>
              上传剧本文件
            </Button>
          </Upload>
          <Text type="secondary" style={{ fontSize: 12 }}>
            支持 .txt / .md 纯文本
          </Text>
        </Space>

        <Text type="secondary" style={{ fontSize: 12 }}>
          剧本生成后，点「三步生成分镜」即可自动拆出镜头、角色/场景/道具要素
        </Text>
      </Space>
    </Card>
  );
}
