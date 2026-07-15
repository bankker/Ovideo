import { Card, Empty, Tag } from 'antd';

/** 未到里程碑的阶段占位页 */
export function StageStub({ title, milestone }: { title: string; milestone: string }) {
  return (
    <Card style={{ margin: 16 }}>
      <Empty
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        style={{ padding: '72px 0' }}
        description={
          <span>
            「{title}」阶段将在 <Tag color="processing">{milestone}</Tag> 里程碑实现，敬请期待
          </span>
        }
      />
    </Card>
  );
}
