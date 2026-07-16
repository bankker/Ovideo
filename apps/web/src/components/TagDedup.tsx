/**
 * 重复标签治理组件（设计页按钮触发 / 剧本页生成后自动触发共用）。
 * - 手动模式（showButton）：点「检查重复标签」→ LLM 语义判重 → 弹窗逐组合并；
 * - 自动模式（autoCheckSignal 变化时）：静默检查，发现疑似重复才显示提醒横幅，干净时零打扰。
 * 合并 = 全部引用重指 + 重命名为建议短名 + 提示词 @旧名 自动改写（服务端保证）。
 */
import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Modal, Radio, Space, Tag, message } from 'antd';
import { MergeCellsOutlined } from '@ant-design/icons';
import type { TagType } from '@ovideo/shared';
import {
  useCheckTagDuplicates,
  useMergeTags,
  useUpdateTag,
  type DuplicateTagGroup,
} from '../api/design-hooks';

const TAG_TYPE_LABEL: Record<string, string> = { CHARACTER: '角色', SCENE: '场景', PROP: '道具' };

export function TagDedup({
  projectId,
  showButton = true,
  autoCheckSignal = 0,
}: {
  projectId: string;
  showButton?: boolean;
  /** 数值变化即触发一次静默检查（如三步生成成功后 +1） */
  autoCheckSignal?: number;
}) {
  const check = useCheckTagDuplicates(projectId);
  const merge = useMergeTags(projectId);
  const updateTag = useUpdateTag(projectId);
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<DuplicateTagGroup[]>([]);
  const [banner, setBanner] = useState(false);
  const [targets, setTargets] = useState<Record<number, string>>({});
  const [merging, setMerging] = useState(false);
  const lastSignal = useRef(autoCheckSignal);

  const runCheck = (silent: boolean) => {
    check.mutate(undefined, {
      onSuccess: (r) => {
        if (r.groups.length === 0) {
          if (!silent) message.success('未发现疑似重复标签');
          setBanner(false);
          return;
        }
        setGroups(r.groups);
        setTargets(Object.fromEntries(r.groups.map((g, i) => [i, g.tags[0].id])));
        if (silent) setBanner(true);
        else setOpen(true);
      },
      onError: (e) => {
        if (!silent) message.error(e.message);
      },
    });
  };

  // 自动触发：signal 变化时静默检查
  useEffect(() => {
    if (autoCheckSignal !== lastSignal.current) {
      lastSignal.current = autoCheckSignal;
      if (autoCheckSignal > 0) runCheck(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheckSignal]);

  const runMerge = async (gi: number) => {
    const group = groups[gi];
    const targetId = targets[gi];
    setMerging(true);
    try {
      for (const t of group.tags) {
        if (t.id !== targetId) {
          await merge.mutateAsync({ sourceTagId: t.id, targetTagId: targetId });
        }
      }
      if (group.suggestedName) {
        await updateTag.mutateAsync({ tagId: targetId, name: group.suggestedName });
      }
      message.success(`已合并 ${group.tags.length} 个标签 → 「${group.suggestedName}」`);
      const rest = groups.filter((_, i) => i !== gi);
      setGroups(rest);
      if (rest.length === 0) {
        setOpen(false);
        setBanner(false);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : '合并失败');
    } finally {
      setMerging(false);
    }
  };

  return (
    <>
      {showButton && (
        <Button icon={<MergeCellsOutlined />} loading={check.isPending} onClick={() => runCheck(false)}>
          检查重复标签
        </Button>
      )}
      {banner && groups.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setBanner(false)}
          message={`检测到 ${groups.length} 组疑似重复标签（同一实体被拆成多个名字，会破坏形象一致性）`}
          action={
            <Button size="small" type="primary" onClick={() => setOpen(true)}>
              立即处理
            </Button>
          }
        />
      )}
      <Modal
        open={open}
        title="疑似重复标签（指同一实体，建议合并）"
        footer={null}
        onCancel={() => setOpen(false)}
        width={560}
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          {groups.map((g, gi) => (
            <div key={gi} style={{ border: '1px solid rgba(5,5,5,0.1)', borderRadius: 8, padding: 12 }}>
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                <Space wrap>
                  <Tag color="blue">{TAG_TYPE_LABEL[g.type as TagType] ?? g.type}</Tag>
                  <span>
                    合并后名称：<b>{g.suggestedName}</b>
                  </span>
                </Space>
                <Radio.Group
                  value={targets[gi]}
                  onChange={(e) => setTargets((prev) => ({ ...prev, [gi]: e.target.value as string }))}
                >
                  <Space direction="vertical" size={4}>
                    {g.tags.map((t) => (
                      <Radio key={t.id} value={t.id}>
                        {t.name}
                        <span style={{ color: '#999', fontSize: 12 }}>
                          {targets[gi] === t.id ? '（保留此标签，其余合并进来）' : ''}
                        </span>
                      </Radio>
                    ))}
                  </Space>
                </Radio.Group>
                <Button type="primary" size="small" loading={merging} onClick={() => void runMerge(gi)}>
                  合并这一组
                </Button>
              </Space>
            </div>
          ))}
        </Space>
      </Modal>
    </>
  );
}
