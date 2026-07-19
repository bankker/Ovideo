import { App as AntdApp, Layout, Menu, Select, Tooltip } from 'antd';
import { BgColorsOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { UI_TEMPLATE_OPTIONS, useUiTemplate } from '../theme/ThemeProvider';

const { Header, Content } = Layout;

const menuItems: MenuProps['items'] = [
  { key: '/', label: '项目管理' },
  { key: '/admin/providers', label: '管理后台' },
];

/** 全局壳：顶栏（logo + 导航 + UI 模板切换）+ 内容区 */
export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const { templateKey, setTemplateKey, headerLight } = useUiTemplate();
  const selectedKey = location.pathname.startsWith('/admin') ? '/admin/providers' : '/';

  return (
    <AntdApp>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', gap: 24, paddingInline: 24 }}>
          <div
            onClick={() => navigate('/')}
            style={{
              color: headerLight ? '#1f1f1f' : '#fff',
              fontSize: 17,
              fontWeight: 600,
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              userSelect: 'none',
            }}
          >
            Ovideo · AI 漫剧创作平台
          </div>
          <Menu
            theme={headerLight ? 'light' : 'dark'}
            mode="horizontal"
            selectedKeys={[selectedKey]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ flex: 1, minWidth: 0, background: 'transparent' }}
          />
          <Tooltip title="全局 UI 模板（即时生效，本机记住选择）">
            <Select
              size="small"
              style={{ width: 128 }}
              value={templateKey}
              onChange={setTemplateKey}
              options={UI_TEMPLATE_OPTIONS}
              suffixIcon={<BgColorsOutlined />}
            />
          </Tooltip>
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </AntdApp>
  );
}
