// What the Appearance tab can edit. `color` items live in workbench.colorCustomizations,
// `setting` items are plain VS Code settings.

import type { Area, BooleanSetting, ColorItem, EnumSetting, FontSetting, NoteItem, NumberSetting } from './types';

const FONT_WEIGHTS = ['normal', 'bold', '100', '200', '300', '400', '500', '600', '700', '800', '900'];

const color = (key: string, label: string, desc = ''): ColorItem => ({ kind: 'color', key, label, desc });
const note = (text: string): NoteItem => ({ kind: 'note', text });
const number = (key: string, label: string, { min, max, step, unit = '', hint = '' }: { min: number; max: number; step: number; unit?: string; hint?: string }): NumberSetting => ({ kind: 'setting', type: 'number', key, label, hint, min, max, step, unit });
const font = (key: string, label: string, hint = ''): FontSetting => ({ kind: 'setting', type: 'font', key, label, hint });
const choice = (key: string, label: string, options: readonly string[]): EnumSetting => ({ kind: 'setting', type: 'enum', key, label, hint: '', options });
const toggle = (key: string, label: string, hint = ''): BooleanSetting => ({ kind: 'setting', type: 'boolean', key, label, hint });

const ansi = (bright: boolean): ColorItem[] =>
  ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White'].map((name) =>
    color(`terminal.ansi${bright ? 'Bright' : ''}${name}`, `${bright ? 'Bright ' : ''}${name.toLowerCase()}`)
  );

export const AREAS: readonly Area[] = [
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
          number('workbench.tree.indent', 'Indent per level', { min: 0, max: 40, step: 1, unit: 'px' }),
          choice('workbench.tree.renderIndentGuides', 'Show indent guides', ['none', 'onHover', 'always']),
          toggle('explorer.compactFolders', 'Compact single-child folders'),
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
          choice('workbench.sideBar.location', 'Sidebar position', ['left', 'right']),
        ],
      },
      {
        title: 'Font',
        items: [
          note('VS Code has no separate font family or size setting for the sidebar: it uses the system UI font. Zoom level scales the whole window, sidebar included.'),
          number('window.zoomLevel', 'Window zoom level', { min: -5, max: 5, step: 0.5 }),
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
          font('editor.fontFamily', 'Font family'),
          number('editor.fontSize', 'Font size', { min: 6, max: 40, step: 1, unit: 'px' }),
          choice('editor.fontWeight', 'Font weight', FONT_WEIGHTS),
          number('editor.lineHeight', 'Line height', { min: 0, max: 60, step: 1, unit: 'px', hint: '0 = automatic' }),
          number('editor.letterSpacing', 'Letter spacing', { min: -5, max: 10, step: 0.1, unit: 'px' }),
          toggle('editor.fontLigatures', 'Font ligatures', 'Needs a font with ligatures, e.g. Fira Code'),
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
          choice('editor.cursorStyle', 'Cursor style', ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin']),
          choice('editor.cursorBlinking', 'Cursor blinking', ['blink', 'smooth', 'phase', 'expand', 'solid']),
          choice('editor.renderLineHighlight', 'Highlight current line', ['none', 'gutter', 'line', 'all']),
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
          toggle('editor.bracketPairColorization.enabled', 'Colorize bracket pairs', 'Overrides bracket colors from the Syntax tab'),
          toggle('editor.minimap.enabled', 'Show minimap'),
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
          font('terminal.integrated.fontFamily', 'Font family', 'Empty = same as the editor'),
          number('terminal.integrated.fontSize', 'Font size', { min: 6, max: 40, step: 1, unit: 'px' }),
          choice('terminal.integrated.fontWeight', 'Font weight', FONT_WEIGHTS),
          choice('terminal.integrated.fontWeightBold', 'Bold font weight', FONT_WEIGHTS),
          number('terminal.integrated.lineHeight', 'Line height', { min: 1, max: 3, step: 0.1, hint: 'Multiplier of the font size' }),
          number('terminal.integrated.letterSpacing', 'Letter spacing', { min: 0, max: 10, step: 1, unit: 'px' }),
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
          choice('terminal.integrated.cursorStyle', 'Cursor style', ['block', 'line', 'underline']),
          toggle('terminal.integrated.cursorBlinking', 'Cursor blinking'),
          number('terminal.integrated.minimumContrastRatio', 'Minimum contrast ratio', { min: 1, max: 21, step: 0.5, hint: '1 = keep exact colors' }),
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
