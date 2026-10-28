package io.github.yuriibondar.claudestrator.actions

import com.google.gson.JsonObject
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.VfsUtilCore
import io.github.yuriibondar.claudestrator.engine.EngineService
import io.github.yuriibondar.claudestrator.engine.EngineStatus
import io.github.yuriibondar.claudestrator.engine.bool
import io.github.yuriibondar.claudestrator.engine.obj
import io.github.yuriibondar.claudestrator.engine.str
import io.github.yuriibondar.claudestrator.ui.Dashboard
import io.github.yuriibondar.claudestrator.ui.Routes

/** The commands of the VS Code extension, in Tools | Claudestrator and wherever the user puts them. */
abstract class ClaudestratorAction : DumbAwareAction() {
    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT

    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null
    }
}

/** An action that opens the dashboard on one route. */
abstract class RouteAction(private val route: () -> JsonObject) : ClaudestratorAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        Dashboard.open(project, route())
    }
}

class OpenDashboardAction : RouteAction({ Routes.home() })

class NewTaskAction : RouteAction({ Routes.home() })

class CheckReadinessAction : RouteAction({ Routes.home(scenario = "readiness") })

class AuditAction : RouteAction({ Routes.home(scenario = "audit") })

class AgentsAction : RouteAction({ Routes.page("agents") })

class ReposAction : RouteAction({ Routes.page("repos") })

class DashboardSettingsAction : RouteAction({ Routes.page("settings") })

class SetupAction : RouteAction({ Routes.page("setup") })

class OpenConfigAction : ClaudestratorAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        fail(project, EngineService.getInstance(project).call("openConfig"))
    }
}

/** What the VS Code "Check Claude Code, Git and GitHub CLI" shows in a dialog. */
class CheckHealthAction : ClaudestratorAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        EngineService.getInstance(project).call("checkHealth").thenAccept { result ->
            val h = result as? JsonObject ?: return@thenAccept
            fun line(name: String, tool: JsonObject?, detail: String?) = "${if (tool?.bool("ok") == true) "✓" else "✗"} $name${detail?.let { ": $it" } ?: ""}"
            val claude = h.obj("claude")
            val git = h.obj("git")
            val gh = h.obj("gh")
            val ghOk = gh?.bool("ok") == true
            val text = listOf(
                line("Claude Code", claude, claude?.str("version") ?: claude?.str("error")),
                line("Git", git, git?.str("version")),
                line("GitHub CLI", gh, if (ghOk) gh?.str("account") ?: gh?.str("version") else gh?.str("error")),
            ).joinToString("\n")
            val ready = claude?.bool("ok") == true && git?.bool("ok") == true
            ApplicationManager.getApplication().invokeLater {
                Messages.showMessageDialog(project, text, if (ready) "Claudestrator is ready." else "Claudestrator needs attention.", if (ready) Messages.getInformationIcon() else Messages.getWarningIcon())
            }
        }.exceptionally { error ->
            ApplicationManager.getApplication().invokeLater { Messages.showErrorDialog(project, error.cause?.message ?: error.message ?: "failed", "Claudestrator") }
            null
        }
    }
}

class RefreshAction : ClaudestratorAction() {
    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val engine = EngineService.getInstance(project)
        if (engine.status == EngineStatus.RUNNING) fail(project, engine.call("refresh")) else engine.restart()
    }
}

/** The selected text becomes the task, with where it came from, as in VS Code. */
class NewTaskFromSelectionAction : ClaudestratorAction() {
    override fun update(e: AnActionEvent) {
        e.presentation.isEnabledAndVisible = e.project != null && e.getData(CommonDataKeys.EDITOR)?.selectionModel?.hasSelection() == true
    }

    override fun actionPerformed(e: AnActionEvent) {
        val project = e.project ?: return
        val editor = e.getData(CommonDataKeys.EDITOR)
        val text = editor?.selectionModel?.selectedText.orEmpty()
        val file = e.getData(CommonDataKeys.VIRTUAL_FILE)
        val line = editor?.let { it.document.getLineNumber(it.selectionModel.selectionStart) + 1 }
        val where = if (file != null && line != null) "\n\n(from ${relative(project, file)}:$line)" else ""
        Dashboard.open(project, Routes.home(compose = if (text.isNotEmpty()) text + where else ""))
    }

    private fun relative(project: Project, file: com.intellij.openapi.vfs.VirtualFile): String {
        val base = project.basePath?.let { com.intellij.openapi.vfs.LocalFileSystem.getInstance().findFileByPath(it) }
        return (base?.let { VfsUtilCore.getRelativePath(file, it) }) ?: file.path
    }
}

private fun fail(project: Project, call: java.util.concurrent.CompletableFuture<*>) {
    call.exceptionally { error ->
        ApplicationManager.getApplication().invokeLater { Messages.showErrorDialog(project, error.cause?.message ?: error.message ?: "failed", "Claudestrator") }
        null
    }
}
