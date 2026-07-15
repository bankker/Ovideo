import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Card,
  Empty,
  List,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import type { CutStatus } from '@ovideo/shared';
import {
  fmtSeconds,
  useCut,
  useCuts,
  type CutDetail,
  type CutItem,
} from '../../api/video-hooks';

const { Text } = Typography;

const CUT_STATUS_TAG: Record<CutStatus, { color: string; label: string }> = {
  DRAFT: { color: 'default', label: '草稿' },
  COMPOSING: { color: 'processing', label: '合成中' },
  READY: { color: 'success', label: '就绪' },
  FAILED: { color: 'error', label: '失败' },
};

/** 成品阶段：Cut 版本列表 + 大播放器 + 下载 + 用料清单 */
export function FinalStage() {
  const { episodeId = '' } = useParams();

  const cutsQuery = useCuts(episodeId);
  const cuts = [...(cutsQuery.data ?? [])].sort((a, b) => b.version - a.version);
  const [selectedCutId, setSelectedCutId] = useState<string | null>(null);

  // 默认选最新的 READY 版本，否则最新版本
  useEffect(() => {
    if (cuts.length === 0) return;
    if (selectedCutId !== null && cuts.some((c) => c.id === selectedCutId)) return;
    const preferred = cuts.find((c) => c.status === 'READY') ?? cuts[0];
    setSelectedCutId(preferred.id);
  }, [cuts, selectedCutId]);

  const cutQuery = useCut(selectedCutId);
  const cut = cutQuery.data;

  return (
    <div style={{ display: 'flex', gap: 12, padding: 12, height: '100%', alignItems: 'stretch' }}>
      {/* 左：版本列表 */}
      <Card
        size="small"
        title="成片版本"
        style={{ width: 240, flexShrink: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, overflowY: 'auto', padding: 8 } }}
      >
        {cutsQuery.isLoading ? (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <Spin />
          </div>
        ) : cuts.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无成片" />
        ) : (
          <List
            size="small"
            dataSource={cuts}
            split={false}
            renderItem={(c) => {
              const st = CUT_STATUS_TAG[c.status];
              return (
                <List.Item
                  onClick={() => setSelectedCutId(c.id)}
                  style={{
                    cursor: 'pointer',
                    borderRadius: 6,
                    padding: '6px 8px',
                    marginBottom: 4,
                    background: c.id === selectedCutId ? '#e6f4ff' : undefined,
                  }}
                >
                  <Space direction="vertical" size={0}>
                    <Space size={8}>
                      <Text strong>v{c.version}</Text>
                      <Tag color={st.color}>{st.label}</Tag>
                    </Space>
                    <Text type="secondary" style={{ fontSize: 11 }}>
                      {new Date(c.createdAt).toLocaleString()}
                    </Text>
                  </Space>
                </List.Item>
              );
            }}
          />
        )}
      </Card>

      {/* 右：播放器 + 用料清单 */}
      <Card
        size="small"
        title={cut !== undefined ? `成片 v${cut.version}` : '成片'}
        style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}
        styles={{ body: { flex: 1, overflowY: 'auto' } }}
      >
        {cuts.length === 0 && !cutsQuery.isLoading ? (
          <Empty description="暂无成片，请先在美化页合成成片" style={{ marginTop: 80 }} />
        ) : cutQuery.isLoading || cut === undefined ? (
          <div style={{ textAlign: 'center', padding: 60 }}>
            <Spin />
          </div>
        ) : (
          <CutPlayer cut={cut} />
        )}
      </Card>
    </div>
  );
}

/** ---------- 单个 Cut 的展示 ---------- */

function CutPlayer({ cut }: { cut: CutDetail }) {
  const items = cut.items ?? [];

  if (cut.status === 'COMPOSING') {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <Spin />
        <div style={{ marginTop: 12 }}>
          <Text type="secondary">该版本正在合成中，完成后自动刷新……</Text>
        </div>
      </div>
    );
  }
  if (cut.status === 'FAILED') {
    return (
      <Alert
        type="error"
        showIcon
        message="该版本合成失败"
        description="请回到美化页重新发起合成。"
        style={{ marginBottom: 12 }}
      />
    );
  }
  if (cut.status === 'DRAFT') {
    return <Alert type="info" showIcon message="该版本尚未合成，请在美化页发起合成。" />;
  }

  const output = cut.outputAsset ?? null;

  return (
    <div>
      {output !== null ? (
        <>
          <video
            controls
            autoPlay={false}
            src={output.uri}
            style={{
              width: '100%',
              maxWidth: 720,
              borderRadius: 8,
              background: '#000',
              display: 'block',
            }}
          />
          <Space style={{ marginTop: 12, marginBottom: 16 }} size={12}>
            <Button type="primary" icon={<DownloadOutlined />} href={output.uri} download>
              下载成片
            </Button>
            {output.durationMs !== null && (
              <Text type="secondary">总时长 {fmtSeconds(output.durationMs)}</Text>
            )}
          </Space>
        </>
      ) : (
        <Alert
          type="warning"
          showIcon
          message="该版本已就绪但缺少产物文件"
          style={{ marginBottom: 12 }}
        />
      )}

      <Card size="small" title="用料清单" styles={{ body: { padding: 0 } }}>
        <Table<CutItem>
          size="small"
          rowKey={(item, index) => `${item.shotId}-${index ?? 0}`}
          dataSource={items}
          pagination={false}
          locale={{ emptyText: '无用料记录' }}
          columns={[
            {
              title: '镜头',
              key: 'index',
              width: 70,
              render: (_v, _item, index) => `#${index + 1}`,
            },
            {
              title: '片段时长',
              key: 'duration',
              width: 100,
              render: (_v, item) => fmtSeconds(item.durationMs ?? null),
            },
            {
              title: '资产',
              key: 'asset',
              render: (_v, item) => {
                const id = item.assetId ?? item.assetUri;
                return (
                  <Text code style={{ fontSize: 12 }}>
                    {id.length > 24 ? `${id.slice(0, 24)}…` : id}
                  </Text>
                );
              },
            },
          ]}
        />
      </Card>
    </div>
  );
}
