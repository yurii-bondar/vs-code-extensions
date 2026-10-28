package io.github.yuriibondar.claudestrator.settings

import com.google.gson.JsonArray
import com.google.gson.JsonElement
import com.google.gson.JsonPrimitive
import com.intellij.openapi.project.Project

/**
 * The settings as the engine reads them: a flat map keyed like VS Code's configuration (`claudestrator.claudePath`),
 * which is what the engine's own code asks for.
 */
object SettingsBridge {
    fun snapshot(project: Project): Map<String, Any> {
        val s = ClaudestratorSettings.get()
        return mapOf(
            "claudestrator.claudePath" to s.claudePath,
            "claudestrator.claudeConfigDir" to s.claudeConfigDir,
            "claudestrator.settingSources" to s.settingSources.toList(),
            "claudestrator.askPermissions" to s.askPermissions,
            "claudestrator.notifications" to s.notifications,
            "claudestrator.workspaceFolder" to WorkspaceSettings.get(project).workspaceFolder,
            "claudestrator.nodePath" to s.nodePath,
            "claudestrator.atlassian.site" to s.atlassianSite,
            "claudestrator.atlassian.email" to s.atlassianEmail,
        )
    }

    /** The engine changed a setting (it does when you pick an account or a workspace in the dashboard). */
    fun apply(project: Project, key: String, value: JsonElement) {
        val s = ClaudestratorSettings.get()
        val text = (value as? JsonPrimitive)?.takeIf { it.isString }?.asString ?: ""
        when (key) {
            "claudestrator.claudePath" -> s.claudePath = text
            "claudestrator.claudeConfigDir" -> s.claudeConfigDir = text
            "claudestrator.settingSources" -> s.settingSources = (value as? JsonArray)?.map { it.asString }?.filter { it in ClaudestratorSettings.SETTING_SOURCES }?.toMutableList() ?: s.settingSources
            "claudestrator.askPermissions" -> s.askPermissions = (value as? JsonPrimitive)?.takeIf { it.isBoolean }?.asBoolean ?: s.askPermissions
            "claudestrator.notifications" -> if (text in ClaudestratorSettings.NOTIFICATIONS) s.notifications = text
            "claudestrator.workspaceFolder" -> WorkspaceSettings.get(project).workspaceFolder = text
            "claudestrator.nodePath" -> s.nodePath = text
            "claudestrator.atlassian.site" -> s.atlassianSite = text
            "claudestrator.atlassian.email" -> s.atlassianEmail = text
        }
    }
}
