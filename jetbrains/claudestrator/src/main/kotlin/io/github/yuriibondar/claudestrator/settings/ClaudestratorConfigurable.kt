package io.github.yuriibondar.claudestrator.settings

import com.intellij.openapi.options.BoundSearchableConfigurable
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogPanel
import com.intellij.ui.dsl.listCellRenderer.textListCellRenderer
import com.intellij.ui.dsl.builder.bindItem
import com.intellij.ui.dsl.builder.bindSelected
import com.intellij.ui.dsl.builder.bindText
import com.intellij.ui.dsl.builder.columns
import com.intellij.ui.dsl.builder.panel
import io.github.yuriibondar.claudestrator.engine.EngineService

/** Settings | Tools | Claudestrator: what the VS Code extension has under `claudestrator.*`. */
class ClaudestratorConfigurable(private val project: Project) : BoundSearchableConfigurable("Claudestrator", "bondevn.claudestrator.settings") {
    private val notificationLabels = mapOf("all" to "All", "needsYou" to "Only when it needs me", "off" to "Off")

    override fun createPanel(): DialogPanel {
        val s = ClaudestratorSettings.get()
        val workspace = WorkspaceSettings.get(project)
        return panel {
            group("Claude Code") {
                row("Claude CLI path:") { textField().bindText(s::claudePath).columns(40).comment("Empty: found on your login shell's PATH, e.g. ~/.local/bin/claude.") }
                row("Account folder:") { textField().bindText(s::claudeConfigDir).columns(40).comment("Used as CLAUDE_CONFIG_DIR, e.g. ~/.claude-alt. Empty: your default account.") }
                row("Node.js path:") { textField().bindText(s::nodePath).columns(40).comment("Runs the engine and the guard hook. Empty: node from your PATH.") }
                row("Settings the agents load:") {
                    ClaudestratorSettings.SETTING_SOURCES.forEach { source ->
                        checkBox(source).bindSelected({ source in s.settingSources }, { on ->
                            if (on && source !in s.settingSources) s.settingSources.add(source)
                            if (!on) s.settingSources.remove(source)
                        })
                    }
                }.rowComment("'project' brings each repo's CLAUDE.md and .claude/ rules; leaving out 'user' keeps your personal plugins and hooks away from the pipeline.")
            }
            group("Behavior") {
                row { checkBox("Ask me before an agent edits a file or runs a command").bindSelected(s::askPermissions).comment("Off: the built-in guard decides (no force-push, no pushes before you confirm, edits only inside the stage's repo, no destructive rm/git).") }
                row("Notifications:") {
                    comboBox(ClaudestratorSettings.NOTIFICATIONS, textListCellRenderer { notificationLabels[it] ?: it ?: "" })
                        .bindItem({ s.notifications }, { it?.let { v -> s.notifications = v } })
                }
                row("Workspace folder:") { textField().bindText(workspace::workspaceFolder).columns(40).comment("This project only. The folder that holds the repos and .claudestrator/config.yaml. Empty: the project folder.") }
            }
            group("Atlassian (Jira and Confluence)") {
                row("Site:") { textField().bindText(s::atlassianSite).columns(30).comment("For example acme.atlassian.net. The API token is kept in the IDE's password safe; set it in the dashboard's Settings.") }
                row("Email:") { textField().bindText(s::atlassianEmail).columns(30) }
            }
        }
    }

    override fun apply() {
        val before = SettingsBridge.snapshot(project)
        super.apply()
        val after = SettingsBridge.snapshot(project)
        val changed = after.keys.filter { before[it] != after[it] }
        if (changed.isNotEmpty()) EngineService.getInstance(project).settingsChanged(changed)
    }
}
