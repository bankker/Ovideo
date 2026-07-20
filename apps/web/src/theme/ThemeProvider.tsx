import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { DEFAULT_TEMPLATE_KEY, getTemplate, scopeTemplateCss, UI_TEMPLATES } from './themes';

const STORAGE_KEY = 'ovideo-ui-template';

interface ThemeContextValue {
  templateKey: string;
  setTemplateKey: (key: string) => void;
  /** 当前模板的顶栏是否浅色（AppLayout 据此调整标题/菜单配色） */
  headerLight: boolean;
}

const ThemeContext = createContext<ThemeContextValue>({
  templateKey: DEFAULT_TEMPLATE_KEY,
  setTemplateKey: () => undefined,
  headerLight: false,
});

// eslint-disable-next-line react-refresh/only-export-components
export function useUiTemplate(): ThemeContextValue {
  return useContext(ThemeContext);
}

// eslint-disable-next-line react-refresh/only-export-components
export const UI_TEMPLATE_OPTIONS = UI_TEMPLATES.map((t) => ({ value: t.key, label: t.label }));

/** 全局主题壳：AntD ConfigProvider（token/算法）+ 模板级全局 CSS 注入 + localStorage 持久化 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [templateKey, setTemplateKeyState] = useState<string>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_TEMPLATE_KEY;
    } catch {
      return DEFAULT_TEMPLATE_KEY;
    }
  });

  const setTemplateKey = (key: string) => {
    setTemplateKeyState(key);
    try {
      localStorage.setItem(STORAGE_KEY, key);
    } catch {
      /* 隐私模式等场景下静默降级为会话级 */
    }
  };

  const template = getTemplate(templateKey);
  // 模板 CSS 一律作用域化：野兽派那套无作用域 + !important 的规则没法靠特异性压过，
  // 只能让它在中性表面页面（body.surface-neutral）里根本不匹配。
  const scopedCss = useMemo(() => scopeTemplateCss(template.css), [template.css]);
  const ctx = useMemo(
    () => ({ templateKey: template.key, setTemplateKey, headerLight: template.headerLight }),
    [template.key, template.headerLight],
  );

  return (
    <ThemeContext.Provider value={ctx}>
      <ConfigProvider locale={zhCN} theme={template.antd}>
        <style>{scopedCss}</style>
        {children}
      </ConfigProvider>
    </ThemeContext.Provider>
  );
}
