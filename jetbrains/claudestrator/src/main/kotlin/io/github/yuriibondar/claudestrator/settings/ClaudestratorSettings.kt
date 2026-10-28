package io.github.yuriibondar.claudestrator.settings

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage

/** The `claudestrator.*` settings of the VS Code extension, with the same names and defaults. */
@Service(Service.Level.APP)
@State(name = "ClaudestratorSettings", storages = [Storage("claudestrator.xml")])
class ClaudestratorSettings : PersistentStateComponent<ClaudestratorSettings.State> {
    class State {
        var claudePath: String = ""
        var claudeConfigDir: String = ""
        var settingSources: MutableList<String> = mutableListOf("project", "local")
        var askPermissions: Boolean = false
        var notifications: String = "all"
        var nodePath: String = ""
        var atlassianSite: String = ""
        var atlassianEmail: String = ""
    }

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    companion object {
        const val PREFIX = "claudestrator."
        val NOTIFICATIONS = listOf("all", "needsYou", "off")
        val SETTING_SOURCES = listOf("user", "project", "local")

        fun get(): State = ApplicationManager.getApplication().getService(ClaudestratorSettings::class.java).state

        /** Whether a notification of this kind is wanted: `needsYou` is the one kind that `needsYou` mode lets through. */
        fun wants(kind: NotificationKind): Boolean = when (get().notifications) {
            "all" -> true
            "needsYou" -> kind == NotificationKind.NEEDS_YOU
            else -> false
        }
    }
}

enum class NotificationKind { NEEDS_YOU, INFO }
