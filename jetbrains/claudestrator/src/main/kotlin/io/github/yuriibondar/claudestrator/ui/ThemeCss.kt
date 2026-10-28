package io.github.yuriibondar.claudestrator.ui

import com.intellij.openapi.editor.colors.EditorColorsManager
import com.intellij.ui.JBColor
import com.intellij.util.ui.JBUI
import com.intellij.util.ui.UIUtil
import java.awt.Color
import javax.swing.UIManager

/**
 * The page is written against VS Code's theme variables (`--vscode-*`). This answers them with the IDE's colors and
 * fonts, so the page looks at home in any theme without a copy of its CSS.
 */
object ThemeCss {
    fun build(): String {
        val dark = !JBColor.isBright()
        val scheme = EditorColorsManager.getInstance().globalScheme
        val editorBg = scheme.defaultBackground
        val panelBg = UIUtil.getPanelBackground()
        val fg = UIUtil.getLabelForeground()
        val muted = UIUtil.getContextHelpForeground()
        val border = JBColor.border()
        val accent = ui("Button.default.startBackground", JBUI.CurrentTheme.Focus.focusColor())
        val accentText = ui("Button.default.foreground", Color.WHITE)
        val secondary = ui("Button.startBackground", mix(panelBg, fg, 0.06))
        val popupBg = ui("PopupMenu.background", panelBg)
        val selection = ui("MenuItem.selectionBackground", mix(popupBg, fg, 0.12))
        val font = UIUtil.getLabelFont()

        val v = linkedMapOf(
            "--vscode-font-family" to "\"${font.family}\", -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif",
            "--vscode-font-size" to "${font.size}px",
            "--vscode-editor-font-family" to "\"${scheme.editorFontName}\", Menlo, Consolas, monospace",
            "--vscode-foreground" to hex(fg),
            "--vscode-descriptionForeground" to hex(muted),
            "--vscode-editor-background" to hex(editorBg),
            "--vscode-sideBar-background" to hex(panelBg),
            "--vscode-editorWidget-background" to hex(mix(editorBg, fg, 0.05)),
            "--vscode-panel-border" to hex(border),
            "--vscode-contrastBorder" to "transparent",
            "--vscode-focusBorder" to hex(ui("Component.focusColor", JBUI.CurrentTheme.Focus.focusColor())),
            "--vscode-list-hoverBackground" to hex(ui("List.hoverBackground", mix(editorBg, fg, 0.08))),
            "--vscode-textLink-foreground" to hex(JBUI.CurrentTheme.Link.Foreground.ENABLED),
            "--vscode-textCodeBlock-background" to hex(mix(editorBg, fg, 0.08)),
            "--vscode-button-background" to hex(accent),
            "--vscode-button-foreground" to hex(accentText),
            "--vscode-button-hoverBackground" to hex(mix(accent, if (dark) Color.WHITE else Color.BLACK, 0.12)),
            "--vscode-button-secondaryBackground" to hex(secondary),
            "--vscode-button-secondaryForeground" to hex(ui("Button.foreground", fg)),
            "--vscode-button-secondaryHoverBackground" to hex(mix(secondary, fg, 0.1)),
            "--vscode-input-background" to hex(UIUtil.getTextFieldBackground()),
            "--vscode-input-foreground" to hex(ui("TextField.foreground", fg)),
            "--vscode-input-border" to hex(ui("Component.borderColor", border)),
            "--vscode-menu-background" to hex(popupBg),
            "--vscode-menu-foreground" to hex(ui("MenuItem.foreground", fg)),
            "--vscode-menu-selectionBackground" to hex(selection),
            "--vscode-menu-selectionForeground" to hex(ui("MenuItem.selectionForeground", fg)),
            "--vscode-notifications-background" to hex(popupBg),
            "--vscode-notifications-foreground" to hex(fg),
            "--vscode-testing-iconPassed" to if (dark) "#73c991" else "#388a34",
            "--vscode-editorWarning-foreground" to if (dark) "#cca700" else "#bf8803",
            "--vscode-errorForeground" to if (dark) "#f48771" else "#a1260d",
            "--vscode-charts-blue" to if (dark) "#3794ff" else "#1a85ff",
            "--vscode-charts-red" to if (dark) "#f14c4c" else "#e51400",
            "--vscode-charts-green" to if (dark) "#89d185" else "#388a34",
            "--vscode-charts-orange" to "#d18616",
            "--vscode-charts-purple" to if (dark) "#b180d7" else "#652d90",
            "--vscode-charts-yellow" to if (dark) "#cca700" else "#bf8803",
        )
        return ":root{color-scheme:${if (dark) "dark" else "light"};${v.entries.joinToString(";") { "${it.key}:${it.value}" }}}"
    }

    private fun ui(key: String, fallback: Color): Color = UIManager.getColor(key) ?: fallback

    private fun mix(a: Color, b: Color, t: Double): Color = Color(
        (a.red + (b.red - a.red) * t).toInt(),
        (a.green + (b.green - a.green) * t).toInt(),
        (a.blue + (b.blue - a.blue) * t).toInt(),
    )

    private fun hex(c: Color): String = String.format("#%02x%02x%02x", c.red, c.green, c.blue)
}
