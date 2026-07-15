import { App as AntdApp, Layout, Menu } from 'antd';
import type { MenuProps } from 'antd';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';

const { Header, Content } = Layout;

const menuItems: MenuProps['items'] = [
  { key: '/', label: '项目管理' },
  { key: '/admin/providers', label: '管理后台' },
];

/** 全局壳：顶栏（logo + 导航）+ 内容区 */
export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const selectedKey = location.pathname.startsWith('/admin') ? '/admin/providers' : '/';

  return (
    <AntdApp>
      <Layout style={{ minHeight: '100vh' }}>
        <Header style={{ display: 'flex', alignItems: 'center', gap: 24, paddingInline: 24 }}>
          <div
            onClick={() => navigate('/')}
            style={{
              color: '#fff',
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
            theme="dark"
            mode="horizontal"
            selectedKeys={[selectedKey]}
            items={menuItems}
            onClick={({ key }) => navigate(key)}
            style={{ flex: 1, minWidth: 0 }}
          />
        </Header>
        <Content style={{ padding: 24 }}>
          <Outlet />
        </Content>
      </Layout>
    </AntdApp>
  );
}
