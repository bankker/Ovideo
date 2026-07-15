import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  Button,
  Card,
  Empty,
  Input,
  List,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import {
  DeleteOutlined,
  DoubleLeftOutlined,
  DoubleRightOutlined,
  EditOutlined,
  PlusOutlined,
  StarFilled,
  StarOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import type { ShotEditableFields, StoryboardPatch, TagType } from '@ovideo/shared';
import {
  useApplyPatch,
  useCreateScriptDraft,
  useGenerateStoryboard,
  useJob,
  useScriptDrafts,
  useStoryboard,
  useStoryboards,
  useUpdateScriptDraft,
  type ShotDetail,
} from '../../api/workflow-hooks';

const { Text, Paragraph } = Typography;

const TAG_COLOR: Record<TagType, string> = {
  CHARACTER: 'blue',
  SCENE: 'volcano',
  PROP: 'gold',
};

const EMPTY_NEW_SHOT = {
  imagePrompt: '',
  videoPrompt: '',
  durationPlannedMs: 12000,
  tags: [] as Array<{ name: string; type: TagType }>,
  dialogue: [] as Array<{ speaker?: string; isNarrator: boolean; text: string }>,
};

/** 剧本阶段（M1 三步生成表单流）：左 剧本稿列表 / 中 内容编辑 / 右 分镜结果 */
export function ScriptStage() {
  const { episodeId = '' } = useParams();
  const qc = useQueryClient();

  /* ---------- 剧本稿 ---------- */
  const draftsQuery = useScriptDrafts(episodeId);
  const drafts = draftsQuery.data;
  const createDraft = useCreateScriptDraft(episodeId);
  const updateDraft = useUpdateScriptDraft(episodeId);

  const [selectedDraftId, setSelectedDraftId] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const loadedDraftRef = useRef<string | null>(null);
  const [renameState, setRenameState] = useState<{ id: string; title: string } | null>(null);

  // 默认选中主剧本；选中项被删时回退
  useEffect(() => {
    if (!drafts || drafts.length === 0) return;
    if (selectedDraftId !== null && drafts.some((d) => d.id === selectedDraftId)) return;
    const main = drafts.find((d) => d.isMain) ?? drafts[0];
    setSelectedDraftId(main.id);
  }, [drafts, selectedDraftId]);

  const selectedDraft = drafts?.find((d) => d.id === selectedDraftId) ?? null;

  // 切换选中稿时载入内容（不覆盖正在输入的文本）
  useEffect(() => {
    if (selectedDraft !== null && loadedDraftRef.current !== selectedDraft.id) {
      loadedDraftRef.current = selectedDraft.id;
      setContent(selectedDraft.content);
    }
  }, [selectedDraft]);

  const dirty = selectedDraft !== null && content !== selectedDraft.content;

  const saveContent = () => {
    if (selectedDraft === null || !dirty) return;
    updateDraft.mutate(
      { draftId: selectedDraft.id, content },
      {
        onSuccess: () => message.success('剧本已保存'),
        onError: (e) => message.error(e.message),
      },
    );
  };

  const handleCreateDraft = () => {
    createDraft.mutate(
      { title: `剧本稿 ${(drafts?.length ?? 0) + 1}` },
      {
        onSuccess: (d) => setSelectedDraftId(d.id),
        onError: (e) => message.error(e.message),
      },
    );
  };

  const handleSetMain = (draftId: string) => {
    updateDraft.mutate(
      { draftId, setMain: true },
      {
        onSuccess: () => message.success('已设为主剧本'),
        onError: (e) => message.error(e.message),
      },
    );
  };

  const handleRenameOk = () => {
    if (renameState === null) return;
    const title = renameState.title.trim();
    if (title === '') {
      message.warning('标题不能为空');
      return;
    }
    updateDraft.mutate(
      { draftId: renameState.id, title },
      {
        onSuccess: () => {
          message.success('已重命名');
          setRenameState(null);
        },
        onError: (e) => message.error(e.message),
      },
    );
  };

  /* ---------- 三步生成 + Job 轮询 ---------- */
  const generate = useGenerateStoryboard();
  const [runningJobId, setRunningJobId] = useState<string | null>(null);
  const jobQuery = useJob(runningJobId);
  const job = jobQuery.data;
  const pendingSelectLatestRef = useRef(false);

  useEffect(() => {
    if (!job || job.id !== runningJobId) return;
    if (job.status === 'SUCCEEDED') {
      message.success('分镜生成完成');
      pendingSelectLatestRef.current = true;
      void qc.invalidateQueries({ queryKey: ['storyboards', episodeId] });
      setRunningJobId(null);
    } else if (job.status === 'FAILED') {
      message.error(job.error ?? '分镜生成失败');
      setRunningJobId(null);
    } else if (job.status === 'CANCELED') {
      message.warning('生成任务已取消');
      setRunningJobId(null);
    }
  }, [job, runningJobId, episodeId, qc]);

  const generating = generate.isPending || runningJobId !== null;

  const handleGenerate = () => {
    if (selectedDraft === null) return;
    if (dirty) {
      message.warning('请先保存剧本内容再生成');
      return;
    }
    generate.mutate(selectedDraft.id, {
      onSuccess: (j) => {
        message.success('已提交生成任务');
        setRunningJobId(j.id);
      },
      onError: (e) => message.error(e.message),
    });
  };

  /* ---------- 分镜结果 ---------- */
  const storyboardsQuery = useStoryboards(episodeId);
  const storyboards = storyboardsQuery.data;
  const [selectedStoryboardId, setSelectedStoryboardId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const storyboardQuery = useStoryboard(selectedStoryboardId);
  const storyboard = storyboardQuery.data;
  const applyPatch = useApplyPatch(episodeId);

  // 默认选最新版本；生成成功后强制切到最新版
  useEffect(() => {
    if (!storyboards || storyboards.length === 0) return;
    const latest = storyboards.reduce((a, b) => (b.version > a.version ? b : a));
    if (pendingSelectLatestRef.current) {
      pendingSelectLatestRef.current = false;
      setSelectedStoryboardId(latest.id);
      return;
    }
    if (selectedStoryboardId === null || !storyboards.some((s) => s.id === selectedStoryboardId)) {
      setSelectedStoryboardId(latest.id);
    }
  }, [storyboards, selectedStoryboardId]);

  /** 应用补丁并切换到返回的新版本；失败抛出（调用方据此保留编辑态） */
  const runPatch = async (patch: StoryboardPatch, successMsg: string) => {
    if (selectedStoryboardId === null) return;
    try {
      const result = await applyPatch.mutateAsync({ storyboardId: selectedStoryboardId, patch });
      setSelectedStoryboardId(result.storyboard.id);
      message.success(successMsg);
    } catch (e) {
      message.error(e instanceof Error ? e.message : '操作失败');
      throw e;
    }
  };

  const [insertState, setInsertState] = useState<{ afterShotId: string; text: string } | null>(
    null,
  );

  const handleInsertOk = async () => {
    if (insertState === null) return;
    const sourceText = insertState.text.trim();
    if (sourceText === '') {
      message.warning('请填写镜头原文');
      return;
    }
    try {
      await runPatch(
        [
          {
            op: 'add_shot',
            afterShotId: insertState.afterShotId,
            shot: { sourceText, ...EMPTY_NEW_SHOT },
          },
        ],
        '已插入分镜',
      );
      setInsertState(null);
    } catch {
      /* 失败保留弹窗 */
    }
  };

  const versionOptions = [...(storyboards ?? [])]
    .sort((a, b) => b.version - a.version)
    .map((s) => ({
      value: s.id,
      label: `v${s.version}${s.stale ? '（剧本已变更）' : ''}`,
    }));

  /* ---------- 布局 ---------- */
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: 12,
        height: '100%',
        minHeight: 480,
        alignItems: 'stretch',
      }}
    >
      {/* 左栏：剧本稿列表 */}
      <Card
        size="small"
        title="剧本稿"
        style={{ width: 260, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, overflowY: 'auto', padding: 8 } }}
        actions={[
          <Button
            key="create"
            type="dashed"
            size="small"
            icon={<PlusOutlined />}
            loading={createDraft.isPending}
            onClick={handleCreateDraft}
          >
            新建剧本稿
          </Button>,
        ]}
      >
        {draftsQuery.isLoading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : !drafts || drafts.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无剧本稿" />
        ) : (
          <List
            size="small"
            dataSource={drafts}
            split={false}
            renderItem={(d) => (
              <List.Item
                onClick={() => setSelectedDraftId(d.id)}
                style={{
                  cursor: 'pointer',
                  borderRadius: 6,
                  padding: '6px 8px',
                  marginBottom: 4,
                  background: d.id === selectedDraftId ? '#e6f4ff' : undefined,
                }}
                actions={[
                  d.isMain ? (
                    <Tooltip key="main" title="当前主剧本">
                      <Button
                        type="text"
                        size="small"
                        icon={<StarFilled style={{ color: '#faad14' }} />}
                      />
                    </Tooltip>
                  ) : (
                    <Tooltip key="main" title="设为主剧本">
                      <Button
                        type="text"
                        size="small"
                        icon={<StarOutlined />}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleSetMain(d.id);
                        }}
                      />
                    </Tooltip>
                  ),
                  <Tooltip key="rename" title="重命名">
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      onClick={(e) => {
                        e.stopPropagation();
                        setRenameState({ id: d.id, title: d.title });
                      }}
                    />
                  </Tooltip>,
                ]}
              >
                <Space size={4} style={{ minWidth: 0 }}>
                  <Text ellipsis style={{ maxWidth: 96 }}>
                    {d.title}
                  </Text>
                  {d.isMain && <Tag color="gold">主剧本</Tag>}
                </Space>
              </List.Item>
            )}
          />
        )}
      </Card>

      {/* 中栏：内容编辑 + 三步生成 */}
      <Card
        size="small"
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, display: 'flex', flexDirection: 'column', gap: 12 } }}
        title={
          selectedDraft ? (
            <Space>
              <span>{selectedDraft.title}</span>
              {selectedDraft.isMain && <Tag color="gold">主剧本</Tag>}
              {dirty && <Tag color="orange">未保存</Tag>}
            </Space>
          ) : (
            '剧本内容'
          )
        }
        extra={
          <Space>
            <Button
              size="small"
              disabled={!dirty}
              loading={updateDraft.isPending}
              onClick={saveContent}
            >
              保存
            </Button>
            <Button
              size="small"
              type="primary"
              icon={<ThunderboltOutlined />}
              disabled={selectedDraft === null}
              loading={generating}
              onClick={handleGenerate}
            >
              三步生成分镜
            </Button>
          </Space>
        }
      >
        {selectedDraft === null ? (
          <Empty description="请先在左侧选择或新建剧本稿" style={{ marginTop: 80 }} />
        ) : (
          <>
            <Input.TextArea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onBlur={saveContent}
              placeholder="在此粘贴或撰写剧本全文……"
              style={{ flex: 1, resize: 'none' }}
              rows={24}
            />
            {runningJobId !== null && (
              <Text type="secondary" style={{ fontSize: 12 }}>
                生成任务进行中（{job?.status === 'RUNNING' ? `进度 ${job.progress}%` : '排队中'}）……
              </Text>
            )}
          </>
        )}
      </Card>

      {/* 右栏：分镜结果（可折叠） */}
      {collapsed ? (
        <div style={{ width: 40, flexShrink: 0 }}>
          <Tooltip title="展开分镜结果" placement="left">
            <Button
              icon={<DoubleLeftOutlined />}
              onClick={() => setCollapsed(false)}
              style={{ width: 40, height: 120, writingMode: 'vertical-rl' }}
            >
              分镜
            </Button>
          </Tooltip>
        </div>
      ) : (
        <Card
          size="small"
          style={{ width: 420, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
          styles={{ body: { flex: 1, overflowY: 'auto', padding: 8 } }}
          title={
            <Space>
              <span>分镜结果</span>
              <Select
                size="small"
                style={{ width: 170 }}
                placeholder="暂无版本"
                value={selectedStoryboardId ?? undefined}
                options={versionOptions}
                onChange={(v) => setSelectedStoryboardId(v)}
              />
            </Space>
          }
          extra={
            <Tooltip title="收起">
              <Button
                type="text"
                size="small"
                icon={<DoubleRightOutlined />}
                onClick={() => setCollapsed(true)}
              />
            </Tooltip>
          }
        >
          {storyboardsQuery.isLoading || storyboardQuery.isLoading ? (
            <div style={{ textAlign: 'center', padding: 40 }}>
              <Spin />
            </div>
          ) : !storyboards || storyboards.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="暂无分镜，请在中栏点击「三步生成分镜」"
              style={{ marginTop: 60 }}
            />
          ) : !storyboard || storyboard.shots.length === 0 ? (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description="该版本没有镜头"
              style={{ marginTop: 60 }}
            />
          ) : (
            <div>
              {[...storyboard.shots]
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((shot, index) => (
                  <div key={shot.id}>
                    <ShotCard
                      shot={shot}
                      index={index}
                      patching={applyPatch.isPending}
                      onUpdateShot={(shotId, fields) =>
                        runPatch([{ op: 'update_shot', shotId, fields }], 'Prompt 已更新')
                      }
                      onRemove={(shotId) => {
                        void runPatch([{ op: 'remove_shot', shotId }], '已删除镜头').catch(
                          () => undefined,
                        );
                      }}
                    />
                    <div style={{ textAlign: 'center', margin: '4px 0 8px' }}>
                      <Button
                        type="dashed"
                        size="small"
                        icon={<PlusOutlined />}
                        style={{ fontSize: 12, width: '90%' }}
                        onClick={() => setInsertState({ afterShotId: shot.id, text: '' })}
                      >
                        插入分镜
                      </Button>
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Card>
      )}

      {/* 重命名弹窗 */}
      <Modal
        title="重命名剧本稿"
        open={renameState !== null}
        onOk={handleRenameOk}
        confirmLoading={updateDraft.isPending}
        onCancel={() => setRenameState(null)}
        okText="确定"
        cancelText="取消"
        destroyOnClose
      >
        <Input
          value={renameState?.title ?? ''}
          maxLength={100}
          placeholder="剧本稿标题"
          onChange={(e) =>
            setRenameState((s) => (s === null ? s : { ...s, title: e.target.value }))
          }
          onPressEnter={handleRenameOk}
        />
      </Modal>

      {/* 插入分镜弹窗 */}
      <Modal
        title="插入分镜"
        open={insertState !== null}
        onOk={() => void handleInsertOk()}
        confirmLoading={applyPatch.isPending}
        onCancel={() => setInsertState(null)}
        okText="插入"
        cancelText="取消"
        destroyOnClose
      >
        <Input.TextArea
          value={insertState?.text ?? ''}
          autoSize={{ minRows: 3, maxRows: 8 }}
          placeholder="镜头原文（对应剧本片段）"
          onChange={(e) => setInsertState((s) => (s === null ? s : { ...s, text: e.target.value }))}
        />
      </Modal>
    </div>
  );
}

/** ---------- 镜头卡片 ---------- */

type PromptField = 'imagePrompt' | 'videoPrompt';

function ShotCard({
  shot,
  index,
  patching,
  onUpdateShot,
  onRemove,
}: {
  shot: ShotDetail;
  index: number;
  patching: boolean;
  onUpdateShot: (shotId: string, fields: ShotEditableFields) => Promise<void>;
  onRemove: (shotId: string) => void;
}) {
  const [editing, setEditing] = useState<{ field: PromptField; value: string } | null>(null);

  const stale = shot.keyframeStale || shot.videoStale;
  const seconds = Math.round(shot.durationPlannedMs / 100) / 10;

  const tagNameById = new Map(shot.tags.map((t) => [t.tagId, t.tag.name]));
  const speakerLabel = (line: ShotDetail['dialogue'][number]) => {
    if (line.isNarrator) return '旁白';
    if (line.speakerTagId !== null) return tagNameById.get(line.speakerTagId) ?? '角色';
    return '角色';
  };

  const savePrompt = async () => {
    if (editing === null) return;
    try {
      await onUpdateShot(shot.id, { [editing.field]: editing.value } as ShotEditableFields);
      setEditing(null);
    } catch {
      /* 失败保留编辑态 */
    }
  };

  const renderPrompt = (field: PromptField, label: string) => {
    const value = shot[field];
    if (editing?.field === field) {
      return (
        <div style={{ marginBottom: 8 }}>
          <Text type="secondary" style={{ fontSize: 12 }}>
            {label}
          </Text>
          <Input.TextArea
            value={editing.value}
            autoSize={{ minRows: 2, maxRows: 6 }}
            style={{ fontSize: 12, marginTop: 2 }}
            onChange={(e) => setEditing((s) => (s === null ? s : { ...s, value: e.target.value }))}
          />
          <Space style={{ marginTop: 4 }}>
            <Button
              size="small"
              type="primary"
              loading={patching}
              onClick={() => void savePrompt()}
            >
              保存
            </Button>
            <Button size="small" onClick={() => setEditing(null)}>
              取消
            </Button>
          </Space>
        </div>
      );
    }
    return (
      <div
        style={{ marginBottom: 4, cursor: 'pointer' }}
        onClick={() => setEditing({ field, value })}
        title="点击编辑"
      >
        <Text type="secondary" style={{ fontSize: 12 }}>
          {label} <EditOutlined style={{ fontSize: 11 }} />
        </Text>
        <div style={{ fontSize: 12, lineHeight: 1.6 }}>
          {value !== '' ? (
            value
          ) : (
            <Text type="secondary" italic>
              （空，点击填写）
            </Text>
          )}
        </div>
      </div>
    );
  };

  return (
    <Card
      size="small"
      style={{ marginBottom: 4 }}
      title={
        <Space size={6}>
          <span>#{index + 1}</span>
          <Text type="secondary" style={{ fontWeight: 'normal', fontSize: 12 }}>
            {seconds}s
          </Text>
        </Space>
      }
      extra={
        <Space size={4}>
          {stale && (
            <Tooltip
              title={`上游已变更：${[
                shot.keyframeStale ? '关键帧待更新' : '',
                shot.videoStale ? '视频待更新' : '',
              ]
                .filter(Boolean)
                .join('、')}`}
            >
              <Tag icon={<WarningOutlined />} color="warning" style={{ marginInlineEnd: 0 }}>
                上游已变更
              </Tag>
            </Tooltip>
          )}
          <Popconfirm
            title="删除该镜头？"
            description="删除后其产物将被回收"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => onRemove(shot.id)}
          >
            <Button type="text" size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      }
    >
      {shot.tags.length > 0 && (
        <div style={{ marginBottom: 6 }}>
          {shot.tags.map((t) => (
            <Tag key={t.tagId} color={TAG_COLOR[t.tag.type]}>
              {t.tag.name}
            </Tag>
          ))}
        </div>
      )}

      <Paragraph
        ellipsis={{ rows: 2, expandable: true, symbol: '展开' }}
        style={{ marginBottom: 8 }}
      >
        {shot.sourceText !== '' ? (
          shot.sourceText
        ) : (
          <Text type="secondary" italic>
            （无原文）
          </Text>
        )}
      </Paragraph>

      {renderPrompt('imagePrompt', '生图 Prompt')}
      {renderPrompt('videoPrompt', '视频 Prompt')}

      {shot.dialogue.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px dashed rgba(5,5,5,0.1)', paddingTop: 6 }}>
          {[...shot.dialogue]
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((line) => (
              <div key={line.id} style={{ fontSize: 12, lineHeight: 1.8 }}>
                <Text strong style={{ fontSize: 12 }}>
                  {speakerLabel(line)}：
                </Text>
                {line.text}
              </div>
            ))}
        </div>
      )}
    </Card>
  );
}
