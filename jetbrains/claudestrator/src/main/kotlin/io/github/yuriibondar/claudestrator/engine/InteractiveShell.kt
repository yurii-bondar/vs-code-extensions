package io.github.yuriibondar.claudestrator.engine

import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindowManager
import java.awt.datatransfer.StringSelection

/**
 * "Continue this Claude session in a terminal". The terminal's own API is experimental, and a plugin that uses it
 * would break with the IDE, so this opens the Terminal tool window and puts the command, with the folder it must run
 * in, on the clipboard: one paste.
 */
object InteractiveShell {
    interface Session {
        fun show()
        fun send(text: String)
        fun close()
    }

    fun open(project: Project, cwd: String?): Session = object : Session {
        override fun show() = ToolWindowManager.getInstance(project).getToolWindow("Terminal")?.activate(null) ?: Unit

        override fun close() = Unit

        override fun send(text: String) {
            CopyPasteManager.getInstance().setContents(StringSelection(inFolder(cwd, text)))
            show()
            NotificationGroupManager.getInstance().getNotificationGroup("Claudestrator")
                .createNotification("Claudestrator", "The command to continue the session is on your clipboard: paste it into the terminal.", NotificationType.INFORMATION)
                .notify(project)
        }
    }

    /** `text` runs in `cwd`, in a POSIX shell or PowerShell (the IDE's terminal default on Windows). */
    private fun inFolder(cwd: String?, text: String): String = when {
        cwd.isNullOrEmpty() -> text
        System.getProperty("os.name").startsWith("Windows") -> "Set-Location -LiteralPath '${cwd.replace("'", "''")}'; $text"
        else -> "cd '${cwd.replace("'", "'\\''")}' && $text"
    }
}
