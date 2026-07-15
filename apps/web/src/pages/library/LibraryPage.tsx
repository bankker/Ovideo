import { useMemo, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button,
  Col,
  Descriptions,
  Empty,
  Modal,
  Popconfirm,
  Row,
  Segmented,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  Upload,
  message,
} from 'antd';
import {
  DeleteOutlined,
  NodeIndexOutlined,
  PlayCircleFilled,
  RedoOutlined,
  SoundOutlined,
  UploadOutlined,
} from '@ant-design/icons';
import type { AssetType } from '@ovideo/shared';
import {
  ASSET_SOURCE_LABEL,
  ASSET_TYPE_COLOR,
  ASSET_TYPE_LABEL,
  useAssetLineage,
  useEpisodeAssets,
  useProjectAssets,
  useRecycleAsset,
  useRestoreAsset,
  useUploadAsset,
  type AssetEntity,
} from '../../api/library-hooks';

const { Text } = Typography;

type Scope = 'episode' | 'project';
type TypeFilter = 'ALL' | Extract<AssetType, 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FRAME' | 'FINAL'>;

const TYPE_FILTER_OPTIONS: Array<{ label: string; value: TypeFilter }> = [
  { label: '全部', value: 'ALL' },
  { label: '图片', value: 'IMAGE' },
  { label: '视频', value: 'VIDEO' },
  { label: '音频', value: 'AUDIO' },
  { label: '帧', value: 'FRAME' },
  { label: '成片', value: 'FINAL' },
];

function formatSeconds(durationMs: number | null): string {
  if (durationMs === null) return '-';
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function formatKB(sizeBytes: number): string {
  return `${(sizeBytes / 1024).toFixed(1)} KB`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('zh-CN', { hour12: false });
}

/** 素材库（v2 §3.12）：本集/全部切换 + 类型筛选 + 上传 + 回收站 + 预览/血缘 */
export function LibraryPage() {
  const { projectId = '', episodeId = '' } = useParams();

  const [scope, setScope] = useState<Scope>('episode');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [recycled, setRecycled] = useState(false);
  const [previewAsset, setPreviewAsset] = useState<AssetEntity | null>(null);
  const [lineageAssetId, setLineageAssetId] = useState<string | null>(null);

  const typeParam = typeFilter === 'ALL' ? undefined : typeFilter;

  const episodeQuery = useEpisodeAssets(scope === 'episode' ? episodeId : '', {
    type: typeParam,
  });
  const projectQuery = useProjectAssets(scope === 'project' ? projectId : '', {
    type: typeParam,
    status: recycled ? 'RECYCLED' : undefined,
  });
  const activeQuery = scope === 'episode' ? episodeQuery : projectQuery;
  // 类型筛选再兜底过滤一次（服务端若未实现 type 参数也保证 UI 正确）
  const assets = useMemo(
    () => (activeQuery.data ?? []).filter((a) => typeParam === undefined || a.type === typeParam),
    [activeQuery.data, typeParam],
  );

  const upload = useUploadAsset(projectId);
  const recycle = useRecycleAsset();
  const restore = useRestoreAsset();

  // 预览中的资产在列表刷新后取最新状态（回收/恢复后按钮跟着变）
  const previewCurrent = useMemo(() => {
    if (previewAsset === null) return null;
    return assets.find((a) => a.id === previewAsset.id) ?? previewAsset;
  }, [assets, previewAsset]);

  const handleScopeChange = (value: Scope) => {
    setScope(value);
    if (value === 'episode') setRecycled(false);
  };

  const handleRecycle = (asset: AssetEntity) => {
    recycle.mutate(asset.id, {
      onSuccess: () => {
        message.success('已回收，可在回收站中恢复');
        setPreviewAsset(null);
      },
      onError: (e) => message.error(e.message),
    });
  };

  const handleRestore = (asset: AssetEntity) => {
    restore.mutate(asset.id, {
      onSuccess: () => {
        message.success('已恢复');
        setPreviewAsset(null);
      },
      onError: (e) => message.error(e.message),
    });
  };

  return (
    <div style={{ padding: 16 }}>
      {/* 顶部工具条 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginBottom: 16,
        }}
      >
        <Segmented
          value={scope}
          onChange={(v) => handleScopeChange(v as Scope)}
          options={[
            { label: '本集素材', value: 'episode' },
            { label: '全部素材', value: 'project' },
          ]}
        />
        <Segmented
          value={typeFilter}
          onChange={(v) => setTypeFilter(v as TypeFilter)}
          options={TYPE_FILTER_OPTIONS}
        />
        <div style={{ flex: 1 }} />
        {scope === 'project' && (
          <Space size={6}>
            <Text type="secondary">查看回收站</Text>
            <Switch size="small" checked={recycled} onChange={setRecycled} />
          </Space>
        )}
        <Upload
          showUploadList={false}
          beforeUpload={(file) => {
            upload.mutate(file, {
              onSuccess: () => message.success('上传成功，已入项目资产库'),
              onError: (e) => message.error(e.message),
            });
            return false;
          }}
        >
          <Button icon={<UploadOutlined />} loading={upload.isPending}>
            上传素材
          </Button>
        </Upload>
      </div>

      {/* 资产网格 */}
      {activeQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 80 }}>
          <Spin />
        </div>
      ) : assets.length === 0 ? (
        <Empty
          style={{ marginTop: 80 }}
          description={
            recycled
              ? '回收站为空'
              : scope === 'episode'
                ? '本集暂无素材（被本集镜头/绑定/配音引用的资产会出现在这里）'
                : '项目暂无素材，可点击右上角上传'
          }
        />
      ) : (
        <Row gutter={[12, 12]}>
          {assets.map((asset) => (
            <Col key={asset.id} xs={12} sm={8} md={6} lg={4}>
              <AssetCard asset={asset} onClick={() => setPreviewAsset(asset)} />
            </Col>
          ))}
        </Row>
      )}

      {/* 预览弹窗 */}
      <Modal
        open={previewCurrent !== null}
        onCancel={() => setPreviewAsset(null)}
        footer={null}
        width={720}
        destroyOnClose
        title={
          previewCurrent !== null && (
            <Space>
              <Tag color={ASSET_TYPE_COLOR[previewCurrent.type]}>
                {ASSET_TYPE_LABEL[previewCurrent.type]}
              </Tag>
              <span>素材预览</span>
              {previewCurrent.status === 'RECYCLED' && <Tag color="red">已回收</Tag>}
            </Space>
          )
        }
      >
        {previewCurrent !== null && (
          <div>
            <div
              style={{
                background: '#000',
                borderRadius: 8,
                display: 'flex',
                justifyContent: 'center',
                alignItems: 'center',
                minHeight: 200,
                marginBottom: 12,
                overflow: 'hidden',
              }}
            >
              <AssetPreview asset={previewCurrent} />
            </div>
            <Descriptions size="small" column={2} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="类型">
                {ASSET_TYPE_LABEL[previewCurrent.type]}
              </Descriptions.Item>
              <Descriptions.Item label="来源">
                {ASSET_SOURCE_LABEL[previewCurrent.source]}
              </Descriptions.Item>
              <Descriptions.Item label="大小">{formatKB(previewCurrent.sizeBytes)}</Descriptions.Item>
              <Descriptions.Item label="时间">
                {formatTime(previewCurrent.createdAt)}
              </Descriptions.Item>
              {previewCurrent.width !== null && previewCurrent.height !== null && (
                <Descriptions.Item label="尺寸">
                  {previewCurrent.width}×{previewCurrent.height}
                </Descriptions.Item>
              )}
              {previewCurrent.durationMs !== null && (
                <Descriptions.Item label="时长">
                  {formatSeconds(previewCurrent.durationMs)}
                </Descriptions.Item>
              )}
            </Descriptions>
            <Space>
              <Button
                icon={<NodeIndexOutlined />}
                onClick={() => setLineageAssetId(previewCurrent.id)}
              >
                查看血缘
              </Button>
              {previewCurrent.status === 'ACTIVE' ? (
                <Popconfirm
                  title="回收该素材？"
                  description="回收后可在「全部素材 → 回收站」中恢复"
                  okText="回收"
                  cancelText="取消"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => handleRecycle(previewCurrent)}
                >
                  <Button danger icon={<DeleteOutlined />} loading={recycle.isPending}>
                    回收
                  </Button>
                </Popconfirm>
              ) : (
                <Button
                  icon={<RedoOutlined />}
                  loading={restore.isPending}
                  onClick={() => handleRestore(previewCurrent)}
                >
                  恢复
                </Button>
              )}
            </Space>
          </div>
        )}
      </Modal>

      {/* 血缘弹窗 */}
      <LineageModal assetId={lineageAssetId} onClose={() => setLineageAssetId(null)} />
    </div>
  );
}

/** ---------- 资产卡片 ---------- */

function AssetCard({ asset, onClick }: { asset: AssetEntity; onClick: () => void }) {
  const isFinal = asset.type === 'FINAL';
  return (
    <div
      onClick={onClick}
      style={{
        border: isFinal ? '2px solid #d4a017' : '1px solid rgba(5,5,5,0.1)',
        borderRadius: 8,
        overflow: 'hidden',
        cursor: 'pointer',
        background: '#fff',
        boxShadow: isFinal ? '0 0 6px rgba(212,160,23,0.35)' : undefined,
      }}
    >
      <div style={{ position: 'relative', height: 120, background: '#f0f0f0' }}>
        <AssetThumb asset={asset} />
        {asset.durationMs !== null && (asset.type === 'VIDEO' || asset.type === 'FINAL') && (
          <span
            style={{
              position: 'absolute',
              right: 6,
              bottom: 6,
              background: 'rgba(0,0,0,0.65)',
              color: '#fff',
              fontSize: 11,
              padding: '0 6px',
              borderRadius: 4,
              lineHeight: '18px',
            }}
          >
            {formatSeconds(asset.durationMs)}
          </span>
        )}
      </div>
      <div style={{ padding: '6px 8px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <Tag color={ASSET_TYPE_COLOR[asset.type]} style={{ marginInlineEnd: 0 }}>
          {ASSET_TYPE_LABEL[asset.type]}
        </Tag>
        <Text type="secondary" style={{ fontSize: 11, flex: 1, minWidth: 0 }} ellipsis>
          {formatTime(asset.createdAt)}
        </Text>
      </div>
    </div>
  );
}

/** 网格缩略：图片直显 / 视频缩略图+播放图标 / 音频图标 */
function AssetThumb({ asset }: { asset: AssetEntity }) {
  if (asset.type === 'IMAGE' || asset.type === 'FRAME') {
    return (
      <img
        src={asset.uri}
        alt=""
        style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
      />
    );
  }
  if (asset.type === 'VIDEO' || asset.type === 'FINAL') {
    return (
      <div style={{ width: '100%', height: '100%', position: 'relative', background: '#1f1f1f' }}>
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
            fontSize: 32,
            color: 'rgba(255,255,255,0.9)',
          }}
        />
      </div>
    );
  }
  // AUDIO / VOICE_SAMPLE
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <SoundOutlined style={{ fontSize: 36, color: '#8c8c8c' }} />
    </div>
  );
}

/** 预览弹窗内的媒体主体 */
function AssetPreview({ asset }: { asset: AssetEntity }) {
  if (asset.type === 'IMAGE' || asset.type === 'FRAME') {
    return (
      <img src={asset.uri} alt="" style={{ maxWidth: '100%', maxHeight: 420, display: 'block' }} />
    );
  }
  if (asset.type === 'VIDEO' || asset.type === 'FINAL') {
    return (
      <video
        src={asset.uri}
        controls
        style={{ maxWidth: '100%', maxHeight: 420, display: 'block' }}
      />
    );
  }
  return (
    <div style={{ padding: 24, width: '100%' }}>
      <audio src={asset.uri} controls style={{ width: '100%' }} />
    </div>
  );
}

/** ---------- 血缘弹窗：ancestors / descendants 两列缩略列表 ---------- */

function LineageModal({ assetId, onClose }: { assetId: string | null; onClose: () => void }) {
  const lineageQuery = useAssetLineage(assetId);
  const lineage = lineageQuery.data;

  return (
    <Modal
      title="资产血缘"
      open={assetId !== null}
      onCancel={onClose}
      footer={null}
      width={640}
      destroyOnClose
    >
      {lineageQuery.isLoading ? (
        <div style={{ textAlign: 'center', padding: 40 }}>
          <Spin />
        </div>
      ) : lineage === undefined ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="血缘信息加载失败" />
      ) : (
        <Row gutter={16}>
          <Col span={12}>
            <LineageColumn title="上游来源（用了什么）" items={lineage.ancestors} />
          </Col>
          <Col span={12}>
            <LineageColumn title="下游产物（被谁使用）" items={lineage.descendants} />
          </Col>
        </Row>
      )}
    </Modal>
  );
}

function LineageColumn({ title, items }: { title: string; items: AssetEntity[] }) {
  return (
    <div>
      <Text strong style={{ display: 'block', marginBottom: 8 }}>
        {title}
      </Text>
      {items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无" />
      ) : (
        <div style={{ maxHeight: 360, overflowY: 'auto' }}>
          {items.map((a) => (
            <div
              key={a.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 4px',
                borderBottom: '1px dashed rgba(5,5,5,0.08)',
              }}
            >
              <div
                style={{
                  width: 48,
                  height: 36,
                  flexShrink: 0,
                  borderRadius: 4,
                  overflow: 'hidden',
                  background: '#f0f0f0',
                }}
              >
                <AssetThumb asset={a} />
              </div>
              <div style={{ minWidth: 0 }}>
                <Tag color={ASSET_TYPE_COLOR[a.type]} style={{ marginInlineEnd: 0 }}>
                  {ASSET_TYPE_LABEL[a.type]}
                </Tag>
                <Text type="secondary" style={{ fontSize: 11, display: 'block' }}>
                  {formatTime(a.createdAt)}
                </Text>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
