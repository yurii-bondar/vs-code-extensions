// The Claudestrator palette (Penpot's Theme/* tokens, resolved) as the VS Code variables the dashboard reads, so the
// captured screens show the design system's colors. Hues stay the dark ones: the code darkens them for light themes.
const T = {
  Dark: { cls: 'vscode-dark', app: '#131312', surface: '#1b1b19', raised: '#232321', hover: '#2a2a27', sunken: '#131312', text: '#edece7', text2: '#a8a69e', link: '#ec9574', onAccent: '#ffffff', border: '#34332f', strong: '#4a4945', focus: '#ec9574', accent: '#b0522f', accentHover: '#a24826' },
  Light: { cls: 'vscode-light', app: '#f6f5f1', surface: '#ffffff', raised: '#fbfaf7', hover: '#edece7', sunken: '#ffffff', text: '#1b1b19', text2: '#57554e', link: '#a24826', onAccent: '#ffffff', border: '#e2e0d9', strong: '#cfcdc5', focus: '#b0522f', accent: '#b0522f', accentHover: '#a24826' },
  'HC Dark': { cls: 'vscode-high-contrast', app: '#000000', surface: '#000000', raised: '#000000', hover: 'rgba(255,255,255,0.08)', sunken: '#000000', text: '#ffffff', text2: '#ffffff', link: '#6fc3df', onAccent: '#000000', border: '#6fc3df', strong: '#6fc3df', focus: '#f38518', accent: '#6fc3df', accentHover: '#ffd370', buttonBorder: '#6fc3df' },
  'HC Light': { cls: 'vscode-high-contrast vscode-high-contrast-light', app: '#ffffff', surface: '#ffffff', raised: '#ffffff', hover: 'rgba(0,0,0,0.06)', sunken: '#ffffff', text: '#000000', text2: '#000000', link: '#0f4a85', onAccent: '#ffffff', border: '#0f4a85', strong: '#0f4a85', focus: '#006bbd', accent: '#0f4a85', accentHover: '#000000' },
};
const HUES = { '--vscode-charts-blue': '#7fb2ff', '--vscode-testing-iconPassed': '#6fcf8e', '--vscode-editorWarning-foreground': '#e6b84f', '--vscode-errorForeground': '#f58378', '--vscode-charts-red': '#f58378', '--vscode-charts-green': '#6fcf8e', '--vscode-charts-yellow': '#e6b84f', '--vscode-charts-purple': '#c49bf0', '--vscode-charts-orange': '#ec9574' };

export const THEME_NAMES = Object.keys(T);

/** JS for the page: the palette after the page's own variables, the fonts, and VS Code's body class. */
export function applyTheme(name) {
  const t = T[name];
  const hc = name.startsWith('HC');
  const vars = {
    '--vscode-font-family': 'Inter, sans-serif', '--vscode-font-size': '13px', '--vscode-editor-font-family': '"JetBrains Mono", monospace',
    '--vscode-foreground': t.text, '--vscode-descriptionForeground': t.text2, '--vscode-editor-background': t.app, '--vscode-sideBar-background': t.surface,
    '--vscode-editorWidget-background': t.raised, '--vscode-panel-border': t.border, '--vscode-list-hoverBackground': t.hover, '--vscode-focusBorder': t.focus,
    '--vscode-textLink-foreground': t.link, '--vscode-button-background': t.accent, '--vscode-button-foreground': t.onAccent, '--vscode-button-hoverBackground': t.accentHover,
    '--vscode-input-background': t.sunken, '--vscode-input-foreground': t.text, '--vscode-input-border': t.border, '--vscode-textCodeBlock-background': t.raised,
    '--vscode-menu-background': t.raised, '--vscode-notifications-background': t.raised, '--vscode-button-secondaryForeground': t.text,
    ...(hc ? { '--vscode-contrastBorder': t.strong, '--vscode-button-border': t.border, '--vscode-button-secondaryBackground': t.app, '--vscode-button-secondaryHoverBackground': t.app } : { '--vscode-button-secondaryBackground': t.hover, '--vscode-button-secondaryHoverBackground': t.border }),
    ...HUES,
  };
  const css = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=block');
:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}} #toasts{display:none!important}`;
  return `(async () => { let s = document.getElementById('design-theme'); if (!s) { s = document.createElement('style'); s.id = 'design-theme'; document.head.appendChild(s); } s.textContent = ${JSON.stringify(css)}; document.body.className = ${JSON.stringify(t.cls)}; await document.fonts.load('13px Inter'); await document.fonts.load('600 13px Inter'); await document.fonts.load('12px "JetBrains Mono"'); await document.fonts.ready; return true; })()`;
}
