package io.github.yuriibondar.claudestrator.ui

import com.intellij.openapi.Disposable
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.util.Consumer
import io.github.yuriibondar.claudestrator.engine.EngineService
import io.github.yuriibondar.claudestrator.engine.LimitWindow
import java.awt.event.MouseEvent

/** The two status bar items of the VS Code extension: what is running or waiting, and the Claude usage limits. */
abstract class ClaudestratorWidgetFactory(private val widgetId: String, private val name: String) : StatusBarWidgetFactory {
    abstract fun create(project: Project): StatusBarWidget

    override fun getId(): String = widgetId

    override fun getDisplayName(): String = name

    override fun isAvailable(project: Project): Boolean = true

    override fun createWidget(project: Project): StatusBarWidget = create(project)

    override fun canBeEnabledOn(statusBar: StatusBar): Boolean = true
}

class TasksStatusWidgetFactory : ClaudestratorWidgetFactory("Claudestrator.Tasks", "Claudestrator Tasks") {
    override fun create(project: Project) = TextWidget(project, "Claudestrator.Tasks") { s ->
        val parts = listOfNotNull(s.running.takeIf { it > 0 }?.let { "▶ $it" }, s.attention.takeIf { it > 0 }?.let { "● $it" })
        val tip = when {
            s.running + s.attention == 0 -> "Nothing needs you right now."
            else -> listOfNotNull(s.running.takeIf { it > 0 }?.let { "$it running" }, s.attention.takeIf { it > 0 }?.let { "$it need you" }).joinToString(", ")
        }
        "Claudestrator${if (parts.isEmpty()) "" else "  " + parts.joinToString("  ")}" to "Claudestrator: $tip"
    }
}

class LimitsStatusWidgetFactory : ClaudestratorWidgetFactory("Claudestrator.Limits", "Claudestrator Claude Limits") {
    override fun create(project: Project) = TextWidget(project, "Claudestrator.Limits") { s ->
        val l = s.limits
        if (l == null) {
            "" to null
        } else {
            fun part(label: String, w: LimitWindow?) = w?.let { "$label ${it.pct}%" }
            val text = listOfNotNull(part("5h", l.fiveHour), part("wk", l.sevenDay)).joinToString(" · ")
            val tip = listOfNotNull(l.fiveHour?.let { "5-hour: ${it.pct}%" }, l.sevenDay?.let { "Weekly: ${it.pct}%" }).joinToString("\n")
            text to "Claude usage limits\n$tip"
        }
    }
}

/** A text item that follows the engine's state; clicking it opens the dashboard. */
class TextWidget(
    private val project: Project,
    private val widgetId: String,
    private val render: (io.github.yuriibondar.claudestrator.engine.EngineState) -> Pair<String, String?>,
) : StatusBarWidget, StatusBarWidget.TextPresentation {
    private val parent: Disposable = Disposer.newDisposable("claudestrator.$widgetId")
    private var bar: StatusBar? = null

    override fun ID(): String = widgetId

    override fun getPresentation(): StatusBarWidget.WidgetPresentation = this

    override fun install(statusBar: StatusBar) {
        bar = statusBar
        EngineService.getInstance(project).addStateListener(parent) { statusBar.updateWidget(widgetId) }
    }

    override fun dispose() {
        Disposer.dispose(parent)
        bar = null
    }

    override fun getText(): String = render(EngineService.getInstance(project).state).first

    override fun getTooltipText(): String? = render(EngineService.getInstance(project).state).second

    override fun getAlignment(): Float = 0f

    override fun getClickConsumer(): Consumer<MouseEvent> = Consumer { Dashboard.open(project) }
}
