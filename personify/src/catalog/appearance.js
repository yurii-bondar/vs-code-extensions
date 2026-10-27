// What the Appearance tab can edit. `color` items live in workbench.colorCustomizations,
// `setting` items are plain VS Code settings.

const FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

const color = (key, label, desc) => ({ kind: 'color', key, label, desc });
const setting = (key, label, type, extra = {}) => ({ kind: 'setting', key, label, type, ...extra });
const note = (text) => ({ kind: 'note', text });

const ansi = (bright) =>
  ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].map((name) =>
    color(`terminal.ansi${bright ? 'Bright' : ''}${name}`, `${bright ? 'Bright ' : ''}${name.toLowerCase()}`)
  );

module.exports = [
  {
    id: 'sidebar',
    title: 'Sidebar',
    icon: '▤',
    desc: 'Explorer with your project files, the activity bar and the other side panels.',
    groups: [
      {
        title: 'Background & text',
        items: [
          color('sideBar.background', 'Background'),
          color('sideBar.foreground', 'Text'),
          color('sideBar.border', 'Border', 'Line between the sidebar and the editor'),
          color('sideBarTitle.foreground', 'Title text', 'e.g. "EXPLORER"'),
          color('sideBarSectionHeader.background', 'Section header background', 'Collapsible headers like your project name, OUTLINE, TIMELINE'),
          color('sideBarSectionHeader.foreground', 'Section header text'),
        ],
      },
      {
        title: 'File tree',
        items: [
          color('list.hoverBackground', 'Hovered row'),
          color('list.activeSelectionBackground', 'Selected row'),
          color('list.activeSelectionForeground', 'Selected row text'),
          color('list.inactiveSelectionBackground', 'Selected row (sidebar not focused)'),
          color('list.focusOutline', 'Focus outline'),
          color('tree.indentGuidesStroke', 'Indent guides'),
          setting('workbench.tree.indent', 'Indent per level', 'number', { min: 0, max: 40, step: 1, unit: 'px' }),
          setting('workbench.tree.renderIndentGuides', 'Show indent guides', 'enum', { options: ['none', 'onHover', 'always'] }),
          setting('explorer.compactFolders', 'Compact single-child folders', 'boolean'),
        ],
      },
      {
        title: 'Git status colors',
        items: [
          color('gitDecoration.modifiedResourceForeground', 'Modified files'),
          color('gitDecoration.untrackedResourceForeground', 'Untracked files'),
          color('gitDecoration.addedResourceForeground', 'Added files'),
          color('gitDecoration.deletedResourceForeground', 'Deleted files'),
          color('gitDecoration.ignoredResourceForeground', 'Ignored files'),
          color('gitDecoration.conflictingResourceForeground', 'Conflicting files'),
        ],
      },
      {
        title: 'Activity bar',
        items: [
          color('activityBar.background', 'Background', 'The narrow icon strip next to the sidebar'),
          color('activityBar.foreground', 'Active icon'),
          color('activityBar.inactiveForeground', 'Inactive icons'),
          color('activityBar.activeBorder', 'Active indicator'),
          color('activityBarBadge.background', 'Badge background'),
          color('activityBarBadge.foreground', 'Badge text'),
          setting('workbench.sideBar.location', 'Sidebar position', 'enum', { options: ['left', 'right'] }),
        ],
      },
      {
        title: 'Font',
        items: [
          note('VS Code has no separate font family or size setting for the sidebar: it uses the system UI font. Zoom level scales the whole window, sidebar included.'),
          setting('window.zoomLevel', 'Window zoom level', 'number', { min: -5, max: 5, step: 0.5 }),
        ],
      },
    ],
  },
  {
    id: 'editor',
    title: 'Editor',
    icon: '✎',
    desc: 'The text area where you write code, plus its tabs, gutter and widgets.',
    groups: [
      {
        title: 'Font',
        items: [
          setting('editor.fontFamily', 'Font family', 'font'),
          setting('editor.fontSize', 'Font size', 'number', { min: 6, max: 40, step: 1, unit: 'px' }),
          setting('editor.fontWeight', 'Font weight', 'enum', { options: FONT_WEIGHTS }),
          setting('editor.lineHeight', 'Line height', 'number', { min: 0, max: 60, step: 1, unit: 'px', hint: '0 = automatic' }),
          setting('editor.letterSpacing', 'Letter spacing', 'number', { min: -5, max: 10, step: 0.1, unit: 'px' }),
          setting('editor.fontLigatures', 'Font ligatures', 'boolean', { hint: 'Needs a font with ligatures, e.g. Fira Code' }),
        ],
      },
      {
        title: 'Background & text',
        items: [
          color('editor.background', 'Background'),
          color('editor.foreground', 'Default text'),
          color('editor.lineHighlightBackground', 'Current line'),
          color('editor.lineHighlightBorder', 'Current line border'),
          color('editor.selectionBackground', 'Selection'),
          color('editor.inactiveSelectionBackground', 'Selection (editor not focused)'),
          color('editor.wordHighlightBackground', 'Same-word highlight'),
          color('editor.findMatchBackground', 'Current search match'),
          color('editor.findMatchHighlightBackground', 'Other search matches'),
          color('editorCursor.foreground', 'Cursor'),
          setting('editor.cursorStyle', 'Cursor style', 'enum', { options: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'] }),
          setting('editor.cursorBlinking', 'Cursor blinking', 'enum', { options: ['blink', 'smooth', 'phase', 'expand', 'solid'] }),
          setting('editor.renderLineHighlight', 'Highlight current line', 'enum', { options: ['none', 'gutter', 'line', 'all'] }),
        ],
      },
      {
        title: 'Gutter & guides',
        items: [
          color('editorGutter.background', 'Gutter background'),
          color('editorLineNumber.foreground', 'Line numbers'),
          color('editorLineNumber.activeForeground', 'Current line number'),
          color('editorIndentGuide.background1', 'Indent guides'),
          color('editorIndentGuide.activeBackground1', 'Active indent guide'),
          color('editorWhitespace.foreground', 'Whitespace dots'),
          color('editorBracketMatch.background', 'Matching bracket'),
          color('editorRuler.foreground', 'Rulers'),
          setting('editor.bracketPairColorization.enabled', 'Colorize bracket pairs', 'boolean', { hint: 'Overrides bracket colors from the Syntax tab' }),
          setting('editor.minimap.enabled', 'Show minimap', 'boolean'),
          color('minimap.background', 'Minimap background'),
        ],
      },
      {
        title: 'Tabs',
        items: [
          color('editorGroupHeader.tabsBackground', 'Tab bar background'),
          color('tab.activeBackground', 'Active tab'),
          color('tab.activeForeground', 'Active tab text'),
          color('tab.activeBorderTop', 'Active tab top border'),
          color('tab.inactiveBackground', 'Inactive tabs'),
          color('tab.inactiveForeground', 'Inactive tab text'),
          color('tab.border', 'Tab separators'),
        ],
      },
      {
        title: 'Widgets',
        items: [
          color('editorWidget.background', 'Find / replace widget'),
          color('editorSuggestWidget.background', 'Autocomplete background'),
          color('editorSuggestWidget.selectedBackground', 'Autocomplete selection'),
          color('editorHoverWidget.background', 'Hover popup'),
        ],
      },
    ],
  },
  {
    id: 'terminal',
    title: 'Terminal',
    icon: '›_',
    desc: 'The integrated terminal and the bottom panel it lives in.',
    groups: [
      {
        title: 'Font',
        items: [
          setting('terminal.integrated.fontFamily', 'Font family', 'font', { hint: 'Empty = same as the editor' }),
          setting('terminal.integrated.fontSize', 'Font size', 'number', { min: 6, max: 40, step: 1, unit: 'px' }),
          setting('terminal.integrated.fontWeight', 'Font weight', 'enum', { options: FONT_WEIGHTS }),
          setting('terminal.integrated.fontWeightBold', 'Bold font weight', 'enum', { options: FONT_WEIGHTS }),
          setting('terminal.integrated.lineHeight', 'Line height', 'number', { min: 1, max: 3, step: 0.1, hint: 'Multiplier of the font size' }),
          setting('terminal.integrated.letterSpacing', 'Letter spacing', 'number', { min: 0, max: 10, step: 1, unit: 'px' }),
        ],
      },
      {
        title: 'Background & text',
        items: [
          color('terminal.background', 'Background'),
          color('terminal.foreground', 'Text'),
          color('terminal.selectionBackground', 'Selection'),
          color('terminalCursor.foreground', 'Cursor'),
          color('terminalCursor.background', 'Text under block cursor'),
          color('terminal.border', 'Split pane border'),
          setting('terminal.integrated.cursorStyle', 'Cursor style', 'enum', { options: ['block', 'line', 'underline'] }),
          setting('terminal.integrated.cursorBlinking', 'Cursor blinking', 'boolean'),
          setting('terminal.integrated.minimumContrastRatio', 'Minimum contrast ratio', 'number', { min: 1, max: 21, step: 0.5, hint: '1 = keep exact colors' }),
        ],
      },
      { title: 'ANSI colors', items: ansi(false) },
      { title: 'Bright ANSI colors', items: ansi(true) },
      {
        title: 'Panel',
        items: [
          color('panel.background', 'Panel background', 'The bottom area holding Terminal, Problems, Output'),
          color('panel.border', 'Panel border'),
          color('panelTitle.activeForeground', 'Active panel title'),
          color('panelTitle.inactiveForeground', 'Inactive panel titles'),
          color('panelTitle.activeBorder', 'Active panel title underline'),
          color('statusBar.background', 'Status bar background'),
          color('statusBar.foreground', 'Status bar text'),
        ],
      },
    ],
  },
];
