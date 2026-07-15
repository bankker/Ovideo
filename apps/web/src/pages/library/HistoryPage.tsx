import { useMemo, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import {
  Alert,
  Button,
  Empty,
  List,
  Popconfirm,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { DeleteOutlined, DownloadOutlined, PlayCircleFilled, SoundOutlined } from '@ant-design/icons';
import type { AssetType } from '@ovideo/shared';
import {
  ASSET_TYPE_COLOR,
  ASSET_TYPE_LABEL,
  useGeneratedAssets,
  useRecycleAsset,
  type AssetEntity,
} from '../../api/library-hooks';

const { Text } = Typography;

type TypeFilter = 'ALL' | Extract<AssetType, 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FRAME' | 'FINAL'>;

const TYPE_FILTER_OPTIONS: Array<{ label: string; value: TypeFilter }> = [
  { label: '全部', value: 'ALL' },
  { label: '图片', value: 'IMAGE' },
  { label: '视频', value: 'VIDEO' },
  { label: '音频', value: 'AUDIO' },
  { label: '帧', value: 'FRAME' },
  { label: '成片', value: 'FINAL' },
];

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 尺寸/时长描述：图片显 宽×高，音视频显秒数 */
function formatDimension(asset: AssetEntity): string {
  if (asset.durationMs !== null) return `${(asset.durationMs / 1000).toFixed(1)}s`;
  if (asset.width !== null && asset.height !== null) return `${asset.width}×${asset.height}`;
  return '-';
}

/** 下载文件名：类型 + 时间戳 + 原扩展名 */
function downloadName(asset: AssetEntity): string {
  const ext = /\.([A-Za-z0-9]+)$/.exec(asset.uri)?.[1] ?? 'bin';
  const stamp = asset.createdAt.replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${asset.type.toLowerCase()}-${stamp}.${ext}`;
}

/** 生成历史（v2 §3.13）：AI 生成产物时间倒序流水 */
export function HistoryPage() {
  const { projectId = '' } = useParams();
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');

  const assetsQuery = useGeneratedAssets(projectId, {
    type: typeFilter === 'ALL' ? undefined : typeFilter,
  });
  const recycle = useRecycleAsset();

  const assets = useMemo(
    () =>
      [...(assetsQuery.data ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      ),
    [assetsQuery.data],
  );

  const handleRecycle = (asset: AssetEntity) => {
    recycle.mutate(asset.id, {
      onSuccess: () => message.success('已回收，可在素材库回收站中恢复'),
      onError: (e) => message.error(e.message),
    });
  };

  return (
    <div style={{ padding: 16, maxWidth: 960, margin: '0 auto' }}>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="此处为 AI 生成产物的流水记录；任务执行明细见右上角任务面板"
      />
      <div style={{ marginBottom: 12 }}>
        <Segmented
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as TypeFilter)}
          options={TYPE_FILTER_OPTIONS}
        />
      </div>

      {assetsQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin />
        </div>
      ) : assets.length === 0 ? (
        <Empty style={{ marginTop: 80 }} description="暂无生成记录" />
      ) : (
        <List
          itemLayout="horizontal"
          dataSource={assets}
          renderItem={(asset) => (
            <List.Item
              actions={[
                <Button
                  key="download"
                  type="text"
                  size="small"
                  icon={<DownloadOutlined />}
                  href={asset.uri}
                  download={downloadName(asset)}
                >
                  下载
                </Button>,
                <Popconfirm
                  key="recycle"
                  title="回收该产物？"
                  description="回收后可在素材库回收站中恢复"
                  okText="回收"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleRecycle(asset)}
                >
                  <Button type="text" size="small" danger icon={<DeleteOutlined />}>
                    回收
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                avatar={<HistoryThumb asset={asset} />}
                title={
                  <Space size={8}>
                    <Tag color={ASSET_TYPE_COLOR[asset.type]} style={{ marginInlineEnd: 0 }}>
                      {ASSET_TYPE_LABEL[asset.type]}
                    </Tag>
                    <Text type="secondary" style={{ fontWeight: 'normal', fontSize: 12 }}>
                      {formatTime(asset.createdAt)}
                    </Text>
                  </Space>
                }
                description={
                  <Text type="secondary" style={{ fontSize: 12 }}>
                    {formatDimension(asset)} · {(asset.sizeBytes / 1024).toFixed(1)} KB
                  </Text>
                }
              />
            </List.Item>
          )}
        />
      )}
    </div>
  );
}

/** 列表缩略：图片直显 / 视频缩略图+播放角标 / 音频图标 */
function HistoryThumb({ asset }: { asset: AssetEntity }) {
  const frame: CSSProperties = {
    width: 88,
    height: 56,
    borderRadius: 6,
    overflow: 'hidden',
    background: '#f0f0f0',
    position: 'relative',
    flexShrink: 0,
  };
  if (asset.type === 'IMAGE' || asset.type === 'FRAME') {
    return (
      <div style={frame}>
        <img
          src={asset.uri}
          alt=""
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      </div>
    );
  }
  if (asset.type === 'VIDEO' || asset.type === 'FINAL') {
    return (
      <div style={{ ...frame, background: '#1f1f1f' }}>
        {asset.thumbUri !== null && (
          <img
            src={asset.thumbUri}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
          />
        )}
        <PlayCircleFilled
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            fontSize: 20,
            color: 'rgba(255,255,255,0.9)',
          }}
        />
      </div>
    );
  }
  return (
    <div style={{ ...frame, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <SoundOutlined style={{ fontSize: 22, color: '#8c8c8c' }} />
    </div>
  );
}
