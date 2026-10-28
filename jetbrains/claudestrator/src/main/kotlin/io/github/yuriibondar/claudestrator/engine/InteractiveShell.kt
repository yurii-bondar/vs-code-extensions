package io.github.yuriibondar.claudestrator.engine

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import java.awt.datatransfer.StringSelection
import com.intellij.openapi.ide.CopyPasteManager

/**
 * A shell tab the engine types a command into (to resume a Claude session where you can talk to it).
 * Needs the Terminal plugin; without it the command is put on the clipboard instead (see terminal-support.xml).
 */
interface InteractiveShell {
    interface Session {
        fun show()
        fun send(text: String)
        fun close()
    }

    fun open(project: Project, name: String, cwd: String?): Session?

    companion object {
        fun open(project: Project, name: String, cwd: String?): Session? {
            val shell = ApplicationManager.getApplication().getService(InteractiveShell::class.java)
            return shell?.open(project, name, cwd) ?: clipboardFallback(project)
        }

        private fun clipboardFallback(project: Project): Session = object : Session {
            override fun show() = Unit
            override fun close() = Unit
            override fun send(text: String) {
                CopyPasteManager.getInstance().setContents(StringSelection(text))
                NotificationGroupManager.getInstance().getNotificationGroup("Claudestrator")
                    .createNotification("Claudestrator", "The Terminal plugin is off, so the command was copied instead: paste it into a terminal.", NotificationType.INFORMATION)
                    .notify(project)
            }
        }
    }
}
