package io.github.yuriibondar.claudestrator

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.intellij.ide.BrowserUtil
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.options.ShowSettingsUtil
import com.intellij.openapi.project.Project
import io.github.yuriibondar.claudestrator.engine.EngineService
import io.github.yuriibondar.claudestrator.engine.array
import io.github.yuriibondar.claudestrator.engine.jsonOf
import io.github.yuriibondar.claudestrator.engine.obj
import io.github.yuriibondar.claudestrator.engine.str
import io.github.yuriibondar.claudestrator.settings.ClaudestratorConfigurable
import io.github.yuriibondar.claudestrator.settings.ClaudestratorSettings
import io.github.yuriibondar.claudestrator.settings.NotificationKind
import io.github.yuriibondar.claudestrator.ui.Dashboard
import io.github.yuriibondar.claudestrator.ui.DashboardEditorProvider
import io.github.yuriibondar.claudestrator.ui.Routes
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/** What the VS Code extension shows when a task needs you, finishes, fails or asks for permission. */
internal class Notifier(private val project: Project, private val engine: EngineService) {
    private val permissions = ConcurrentHashMap<String, Notification>()

    fun onEngineEvent(name: String, data: JsonElement?) {
        val d = data as? JsonObject ?: return
        val taskId = d.str("taskId")
        val visible = DashboardEditorProvider.isVisible(project)
        when (name) {
            "checkpoint" -> if (ClaudestratorSettings.wants(NotificationKind.NEEDS_YOU) && !visible && taskId != null) {
                val checkpoint = CHECKPOINT_TITLE[d.obj("checkpoint")?.str("id")] ?: "Your answer"
                notify("Claudestrator needs you", "$taskId needs you: $checkpoint", d.str("title"), NotificationType.INFORMATION, "Claudestrator needs you") {
                    addAction(open("Open", taskId))
                }
            }
            "finished" -> if (ClaudestratorSettings.wants(NotificationKind.INFO) && taskId != null) {
                val state = d.obj("state")
                val prs = state?.obj("prs")?.entrySet()?.mapNotNull { it.value.takeIf { v -> v.isJsonPrimitive }?.asString } ?: emptyList()
                val text = if (state?.str("outcome") == "published") "$taskId: draft PRs are open." else "$taskId is done."
                notify("Claudestrator", text, null, NotificationType.INFORMATION, "Claudestrator") {
                    if (prs.isNotEmpty()) addAction(NotificationAction.createSimpleExpiring("Open PRs") { prs.forEach { BrowserUtil.browse(it) } })
                    addAction(open("Open", taskId))
                }
            }
            "log" -> if (d.str("level") == "error" && ClaudestratorSettings.wants(NotificationKind.INFO) && !visible) {
                notify("Claudestrator", "${taskId?.let { "$it: " } ?: ""}${d.str("message") ?: "Something failed."}", null, NotificationType.ERROR, "Claudestrator") {
                    if (taskId != null) addAction(open("Open", taskId))
                }
            }
            "permission" -> permission(d, taskId)
            "permissionDone" -> (data.asJsonPrimitive?.takeIf { it.isString })?.asString?.let { permissions.remove(it)?.expire() }
        }
    }

    /** An agent wants to edit a file or run a command and you asked to be asked. */
    private fun permission(d: JsonObject, taskId: String?) {
        val requestId = d.str("requestId") ?: return
        val tool = d.str("tool") ?: "a tool"
        val input = d.obj("input")
        val what = when {
            tool == "Bash" -> "run `${(input?.str("command") ?: "").take(120)}`"
            input?.str("file_path") != null -> "${tool.lowercase()} ${File(input.str("file_path")!!).name}"
            else -> "use $tool"
        }
        val who = "${d.str("agent") ?: "An agent"}${d.str("repo")?.let { " @ $it" } ?: ""}"
        val reply = { allow: Boolean -> engine.call("permissionReply", jsonOf("requestId" to requestId, "allow" to allow)) }
        val n = notify("Claudestrator needs you", "$who wants to $what", taskId?.let { "Task $it" }, NotificationType.WARNING, "Claudestrator needs you") {
            addAction(NotificationAction.createSimpleExpiring("Allow") { reply(true) })
            addAction(NotificationAction.createSimpleExpiring("Deny") { reply(false) })
            if (taskId != null) addAction(open("Open", taskId))
        }
        permissions[requestId] = n
        n.whenExpired { permissions.remove(requestId) }
    }

    /** The engine could not start: say why, and where to fix it. */
    fun engineProblem(problem: String?) {
        notify("Claudestrator", problem ?: "The engine could not be started.", null, NotificationType.ERROR, "Claudestrator") {
            addAction(NotificationAction.createSimpleExpiring("Open Settings") { ShowSettingsUtil.getInstance().showSettingsDialog(project, ClaudestratorConfigurable::class.java) })
        }
    }

    private fun open(title: String, taskId: String) = NotificationAction.createSimpleExpiring(title) { Dashboard.open(project, Routes.task(taskId)) }

    private fun notify(title: String, content: String, subtitle: String?, type: NotificationType, group: String, configure: Notification.() -> Unit): Notification {
        val n = NotificationGroupManager.getInstance().getNotificationGroup(group).createNotification(title, content, type)
        subtitle?.let { n.setSubtitle(it) }
        n.configure()
        n.notify(project)
        return n
    }

    private companion object {
        /** `claudestrator/src/core/describe.ts`, CHECKPOINT_TITLE. */
        val CHECKPOINT_TITLE = mapOf(
            "approve-plan" to "Plan approval",
            "gate-failure" to "Checks are red",
            "agent-failure" to "An agent failed",
            "review-limit" to "Review rounds used up",
            "hook-failure" to "Commit failed",
            "confirm-push" to "Confirm push",
        )
    }
}
