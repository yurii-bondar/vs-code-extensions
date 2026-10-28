package io.github.yuriibondar.claudestrator

import com.intellij.openapi.project.Project
import com.intellij.openapi.startup.ProjectActivity
import io.github.yuriibondar.claudestrator.engine.EngineService

/** Starts the engine once the project has opened, so tasks that run in the background are noticed from the start. */
class StartupActivity : ProjectActivity {
    override suspend fun execute(project: Project) = EngineService.getInstance(project).ensureStarted()
}
