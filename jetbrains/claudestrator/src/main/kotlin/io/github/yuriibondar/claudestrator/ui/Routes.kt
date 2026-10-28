package io.github.yuriibondar.claudestrator.ui

import com.google.gson.JsonObject
import com.intellij.openapi.project.Project
import io.github.yuriibondar.claudestrator.engine.EngineService
import io.github.yuriibondar.claudestrator.engine.jsonOf

/** Where the dashboard opens: the engine's `Route` (claudestrator/src/core/wire.ts). */
object Routes {
    fun home(compose: String? = null, scenario: String? = null): JsonObject = jsonOf("name" to "home", "compose" to compose, "scenario" to scenario)

    fun page(name: String): JsonObject = jsonOf("name" to name)

    fun task(taskId: String, focus: String? = null): JsonObject = jsonOf("name" to "task", "taskId" to taskId, "focus" to focus)
}

object Dashboard {
    fun open(project: Project, route: JsonObject = Routes.home()) = EngineService.getInstance(project).openDashboard(route)
}
