import { Button, Popover, Typography } from 'antd';
import { FileTextOutlined } from '@ant-design/icons';

const { Text, Paragraph } = Typography;

interface GenMeta {
  effectivePrompt?: string;
  refImages?: string[];
}

/**
 * 生成透明度：展示某张生成图实际送给模型的完整提示词与参考图清单。
 * 数据来自 Asset.metaJson（生成执行器写入）；上传图或旧版本生成的图没有此数据。
 */
export function EffectivePromptPopover({
  metaJson,
  compact = false,
}: {
  metaJson: string | undefined;
  /** true = 图块角标按钮形态（用于候选缩略图叠加层）；false = 文字链接形态 */
  compact?: boolean;
}) {
  let meta: GenMeta = {};
  try {
    meta = JSON.parse(metaJson ?? '{}') as GenMeta;
  } catch {
    /* 坏数据当作无记录 */
  }
  const refImages = meta.refImages ?? [];
  const hasData = Boolean(meta.effectivePrompt) || refImages.length > 0;

  const content = hasData ? (
    <div style={{ maxWidth: 420 }}>
      {meta.effectivePrompt !== undefined && meta.effectivePrompt !== '' && (
        <Paragraph
          copyable
          style={{
            whiteSpace: 'pre-wrap',
            fontSize: 12,
            maxHeight: 260,
            overflow: 'auto',
            marginBottom: refImages.length > 0 ? 8 : 0,
          }}
        >
          {meta.effectivePrompt}
        </Paragraph>
      )}
      {refImages.length > 0 && (
        <div>
          <Text type="secondary" style={{ fontSize: 12 }}>
            参考图：
          </Text>
          {refImages.map((r, i) => (
            <div key={i} style={{ fontSize: 12, wordBreak: 'break-all' }}>
              {r}
            </div>
          ))}
        </div>
      )}
    </div>
  ) : (
    <Text type="secondary" style={{ fontSize: 12 }}>
      该图未记录生成信息（上传图或旧版本生成的图没有此数据）
    </Text>
  );

  return (
    <Popover content={content} title="送给模型的实际提示词" trigger="click" placement="right">
      {compact ? (
        <Button
          size="small"
          icon={<FileTextOutlined />}
          onClick={(e) => e.stopPropagation()}
          style={{ opacity: 0.85 }}
        />
      ) : (
        <Text type="secondary" style={{ fontSize: 12, cursor: 'pointer' }}>
          <FileTextOutlined /> 实际提示词
        </Text>
      )}
    </Popover>
  );
}
