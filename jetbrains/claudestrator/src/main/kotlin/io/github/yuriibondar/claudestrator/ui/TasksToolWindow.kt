package io.github.yuriibondar.claudestrator.ui

import com.intellij.icons.AllIcons
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.Disposable
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.DefaultActionGroup
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.DumbAwareAction
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.AnimatedIcon
import com.intellij.ui.ColoredTreeCellRenderer
import com.intellij.ui.DoubleClickListener
import com.intellij.ui.PopupHandler
import com.intellij.ui.ScrollPaneFactory
import com.intellij.ui.SimpleTextAttributes
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.treeStructure.Tree
import io.github.yuriibondar.claudestrator.engine.EngineService
import io.github.yuriibondar.claudestrator.engine.EngineStatus
import io.github.yuriibondar.claudestrator.engine.TaskCard
import java.awt.BorderLayout
import java.awt.event.MouseEvent
import java.io.File
import java.time.Duration
import java.time.Instant
import javax.swing.Icon
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.JTree
import javax.swing.event.TreeExpansionEvent
import javax.swing.event.TreeExpansionListener
import javax.swing.tree.DefaultMutableTreeNode
import javax.swing.tree.DefaultTreeModel
import javax.swing.tree.TreePath

/** The Tasks list: your tasks grouped by what they need from you (the VS Code sidebar view). */
class TasksToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = TasksPanel(project)
        Disposer.register(toolWindow.disposable, panel)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel.component, "", false))

        val actions = ActionManager.getInstance()
        fun action(id: String): AnAction = actions.getAction(id)
        toolWindow.setTitleActions(listOf(action("Claudestrator.NewTask"), action("Claudestrator.OpenDashboard"), action("Claudestrator.Agents"), action("Claudestrator.Refresh")))
        toolWindow.setAdditionalGearActions(
            DefaultActionGroup(action("Claudestrator.Repos"), action("Claudestrator.DashboardSettings"), action("Claudestrator.OpenConfig"), action("Claudestrator.Setup"), action("Claudestrator.CheckHealth")),
        )
        EngineService.getInstance(project).ensureStarted()
    }
}

private data class Group(val id: String, val label: String, val expandedByDefault: Boolean)

private val GROUPS = listOf(
    Group("attention", "Needs you", true),
    Group("running", "Running", true),
    Group("stopped", "Paused", true),
    Group("done", "Finished", false),
)

private fun icon(card: TaskCard): Icon = when (card.statusKey) {
    "running" -> AnimatedIcon.Default.INSTANCE
    "waiting" -> AllIcons.General.BalloonInformation
    "failed", "corrupt" -> AllIcons.General.Error
    "interrupted" -> AllIcons.General.Warning
    "stopped" -> AllIcons.Actions.Pause
    "done" -> AllIcons.RunConfigurations.TestPassed
    else -> AllIcons.Actions.Resume
}

private fun ago(iso: String?): String {
    val then = runCatching { Instant.parse(iso) }.getOrNull() ?: return ""
    val s = Duration.between(then, Instant.now()).seconds
    return when {
        s < 60 -> "just now"
        s < 3600 -> "${s / 60}m ago"
        s < 86400 -> "${s / 3600}h ago"
        else -> "${s / 86400}d ago"
    }
}

private class TasksPanel(private val project: Project) : Disposable {
    private val engine = EngineService.getInstance(project)
    private val root = DefaultMutableTreeNode()
    private val model = DefaultTreeModel(root)
    private val expanded = GROUPS.filter { it.expandedByDefault }.map { it.id }.toMutableSet()
    private var rebuilding = false

    private val tree = object : Tree(model) {
        override fun getToolTipText(event: MouseEvent): String? {
            val card = (getPathForLocation(event.x, event.y)?.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? TaskCard ?: return null
            return tooltip(card)
        }
    }

    val component: JComponent = JPanel(BorderLayout()).apply { add(ScrollPaneFactory.createScrollPane(tree, true), BorderLayout.CENTER) }

    init {
        tree.isRootVisible = false
        tree.showsRootHandles = true
        tree.toolTipText = ""
        tree.cellRenderer = object : ColoredTreeCellRenderer() {
            override fun customizeCellRenderer(tree: JTree, value: Any?, selected: Boolean, expanded: Boolean, leaf: Boolean, row: Int, hasFocus: Boolean) {
                when (val o = (value as? DefaultMutableTreeNode)?.userObject) {
                    is Group -> {
                        append(o.label, SimpleTextAttributes.REGULAR_BOLD_ATTRIBUTES)
                        append("  ${(value as DefaultMutableTreeNode).childCount}", SimpleTextAttributes.GRAYED_ATTRIBUTES)
                    }
                    is TaskCard -> {
                        icon = icon(o)
                        append(o.title)
                        val detail = listOfNotNull(o.taskId, o.liveText ?: o.statusLabel, if (o.statusKey == "done") ago(o.updatedAt) else null).filter { it.isNotEmpty() }.joinToString(" · ")
                        append("  $detail", SimpleTextAttributes.GRAYED_SMALL_ATTRIBUTES)
                    }
                }
            }
        }
        tree.addTreeExpansionListener(object : TreeExpansionListener {
            override fun treeExpanded(event: TreeExpansionEvent) = track(event.path, true)
            override fun treeCollapsed(event: TreeExpansionEvent) = track(event.path, false)
        })
        object : DoubleClickListener() {
            override fun onDoubleClick(event: MouseEvent): Boolean {
                val card = selected() ?: return false
                Dashboard.open(project, Routes.task(card.taskId))
                return true
            }
        }.installOn(tree)
        tree.addMouseListener(object : PopupHandler() {
            override fun invokePopup(c: java.awt.Component, x: Int, y: Int) {
                val path = tree.getPathForLocation(x, y) ?: return
                tree.selectionPath = path
                val card = selected() ?: return
                ActionManager.getInstance().createActionPopupMenu("ClaudestratorTasks", menuFor(card)).component.show(c, x, y)
            }
        })
        engine.addStateListener(this) { refresh() }
        refresh()
    }

    private fun selected(): TaskCard? = (tree.selectionPath?.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? TaskCard

    private fun track(path: TreePath, open: Boolean) {
        if (rebuilding) return
        val g = (path.lastPathComponent as? DefaultMutableTreeNode)?.userObject as? Group ?: return
        if (open) expanded.add(g.id) else expanded.remove(g.id)
    }

    private fun refresh() {
        val selectedId = selected()?.taskId
        val cards = engine.state.cards
        rebuilding = true
        try {
            root.removeAllChildren()
            for (g in GROUPS) {
                val inGroup = cards.filter { it.group == g.id }
                if (inGroup.isEmpty()) continue
                val node = DefaultMutableTreeNode(g)
                inGroup.forEach { node.add(DefaultMutableTreeNode(it)) }
                root.add(node)
            }
            model.reload()
            for (i in 0 until root.childCount) {
                val node = root.getChildAt(i) as DefaultMutableTreeNode
                val g = node.userObject as Group
                if (g.id in expanded) tree.expandPath(TreePath(node.path))
                if (selectedId != null) node.children().asSequence().map { it as DefaultMutableTreeNode }.firstOrNull { (it.userObject as TaskCard).taskId == selectedId }?.let { tree.selectionPath = TreePath(it.path) }
            }
        } finally {
            rebuilding = false
        }
        updateEmptyText()
    }

    /** What the empty list says: how to start, or why nothing works (the engine's own explanation). */
    private fun updateEmptyText() {
        val empty = tree.emptyText
        empty.clear()
        when (engine.status) {
            EngineStatus.FAILED -> {
                empty.appendLine(engine.problem ?: "The engine is not running.")
                empty.appendLine("Try again", SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) { engine.restart() }
            }
            EngineStatus.STARTING -> empty.appendLine("Starting…")
            else -> {
                empty.appendLine("Hand a task to a pipeline of Claude Code agents:")
                empty.appendLine("they plan it, you approve, they write the code and tests")
                empty.appendLine("in each repo, review it, and open draft PRs once you confirm.")
                empty.appendLine("New Task", SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) { Dashboard.open(project, Routes.home()) }
                empty.appendLine("Check readiness", SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) { Dashboard.open(project, Routes.home(scenario = "readiness")) }
                empty.appendLine("Audit", SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) { Dashboard.open(project, Routes.home(scenario = "audit")) }
                empty.appendLine("First time here? Set up this project", SimpleTextAttributes.LINK_PLAIN_ATTRIBUTES) { Dashboard.open(project, Routes.page("setup")) }
            }
        }
    }

    private fun menuFor(card: TaskCard): DefaultActionGroup {
        val group = DefaultActionGroup()
        fun item(text: String, run: () -> Unit) = group.add(object : DumbAwareAction(text) {
            override fun actionPerformed(e: AnActionEvent) = run()
        })
        item("Open Task") { Dashboard.open(project, Routes.task(card.taskId)) }
        if (card.waiting) item("Answer…") { Dashboard.open(project, Routes.task(card.taskId, focus = "checkpoint")) }
        if (card.resumable) item("Run / Resume Task") { call("runTask", card) }
        if (card.running) item("Stop Task") { call("stopTask", card) }
        group.addSeparator()
        item("Reveal Task Folder") {
            engine.call("taskFolderFile", taskParams(card)).thenAccept { path -> path?.asString?.let { RevealFileAction.openFile(File(it)) } }
        }
        if (!card.running) item("Delete Task…") { call("deleteTask", card) }
        return group
    }

    private fun taskParams(card: TaskCard) = com.google.gson.JsonObject().apply { addProperty("taskId", card.taskId) }

    private fun call(method: String, card: TaskCard) {
        engine.call(method, taskParams(card)).exceptionally { e ->
            com.intellij.openapi.application.ApplicationManager.getApplication().invokeLater { Messages.showErrorDialog(project, e.cause?.message ?: e.message ?: "failed", "Claudestrator") }
            null
        }
    }

    private fun tooltip(card: TaskCard): String {
        val lines = mutableListOf("<b>${esc(card.title)}</b>", "${esc(card.taskId)} · ${esc(card.statusLabel)}${card.liveText?.let { " · ${esc(it)}" } ?: ""}")
        card.checkpointHint?.let { lines += esc(it) }
        card.errorMessage?.let { lines += "Error: ${esc(it)}" }
        card.updatedAt?.let { lines += "Updated ${ago(it)}" }
        return "<html>${lines.joinToString("<br>")}</html>"
    }

    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    override fun dispose() = Unit
}
