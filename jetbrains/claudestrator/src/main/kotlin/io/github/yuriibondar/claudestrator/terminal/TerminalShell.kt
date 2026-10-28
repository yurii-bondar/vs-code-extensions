package io.github.yuriibondar.claudestrator.terminal

import com.intellij.openapi.project.Project
import io.github.yuriibondar.claudestrator.engine.InteractiveShell
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/** Loaded only when the Terminal plugin is there (terminal-support.xml); the rest of the plugin never names its classes. */
class TerminalShell : InteractiveShell {
    override fun open(project: Project, name: String, cwd: String?): InteractiveShell.Session {
        val widget = TerminalToolWindowManager.getInstance(project).createShellWidget(cwd, name, true, true)
        return object : InteractiveShell.Session {
            override fun show() = Unit
            override fun send(text: String) = widget.sendCommandToExecute(text)
            override fun close() = widget.dispose()
        }
    }
}
