package io.github.yuriibondar.claudestrator.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.StoragePathMacros
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project

/** What is per project: the folder that holds the repos and `.claudestrator/config.yaml`. Empty: the project's folder. */
@Service(Service.Level.PROJECT)
@State(name = "ClaudestratorWorkspace", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
class WorkspaceSettings : PersistentStateComponent<WorkspaceSettings.State> {
    class State {
        var workspaceFolder: String = ""
    }

    private var state = State()

    override fun getState(): State = state

    override fun loadState(state: State) {
        this.state = state
    }

    companion object {
        fun get(project: Project): State = project.service<WorkspaceSettings>().state
    }
}
