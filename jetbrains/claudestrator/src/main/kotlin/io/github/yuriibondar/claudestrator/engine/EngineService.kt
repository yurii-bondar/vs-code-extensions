package io.github.yuriibondar.claudestrator.engine

import com.google.gson.JsonElement
import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.PathManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.project.Project
import com.intellij.util.EnvironmentUtil
import com.intellij.util.concurrency.AppExecutorUtil
import io.github.yuriibondar.claudestrator.Notifier
import io.github.yuriibondar.claudestrator.settings.ClaudestratorSettings
import io.github.yuriibondar.claudestrator.settings.SettingsBridge
import io.github.yuriibondar.claudestrator.ui.DashboardEditorProvider
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.io.OutputStreamWriter
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.Path
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

private val LOG = logger<EngineService>()

enum class EngineStatus { STOPPED, STARTING, RUNNING, FAILED }

/**
 * Owns the engine of one project: a Node process that runs the Claudestrator engine (see sidecar/) and talks to the
 * plugin over stdio. It starts after the project has opened, off the UI thread, and stops with the project.
 */
@Service(Service.Level.PROJECT)
class EngineService(private val project: Project) : Disposable {
    @Volatile var status: EngineStatus = EngineStatus.STOPPED
        private set

    /** Why the engine is not running, for the list's empty text. Null while it is, or has not been asked to start. */
    @Volatile var problem: String? = null
        private set

    @Volatile var state: EngineState = EngineState.EMPTY
        private set

    private val stateListeners = CopyOnWriteArrayList<() -> Unit>()
    private val pageSinks = CopyOnWriteArrayList<(String) -> Unit>()
    private val pending = HashMap<Int, CompletableFuture<JsonElement?>>()
    private val nextCall = AtomicInteger(1)
    private val hostRequests = HostRequests(project, this)
    private val notifier = Notifier(project, this)

    @Volatile private var process: Process? = null
    private var writer: OutputStreamWriter? = null

    // ---------- lifecycle ----------

    /** Starts the engine unless it runs or is starting. Returns at once; the outcome is `status`. */
    @Synchronized
    fun ensureStarted() {
        if (status == EngineStatus.STARTING || status == EngineStatus.RUNNING) return
        status = EngineStatus.STARTING
        problem = null
        notifyState()
        AppExecutorUtil.getAppExecutorService().execute { launch() }
    }

    @Synchronized
    fun restart() {
        stopProcess()
        status = EngineStatus.STOPPED
        ensureStarted()
    }

    private fun launch() {
        try {
            val node = findNode() ?: return fail("Node.js was not found. Install Node.js 18 or newer, or set its path in Settings | Tools | Claudestrator.")
            val engineDir = enginePath() ?: return fail("The plugin's engine files are missing; reinstall the plugin.")
            val workDir = project.basePath ?: return fail("Open a project folder to use Claudestrator.")
            val cmd = GeneralCommandLine(node, engineDir.resolve("dist/sidecar.js").toString())
                .withWorkDirectory(workDir)
                .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
                .withCharset(StandardCharsets.UTF_8)
            val started = cmd.createProcess()
            synchronized(this) {
                process = started
                writer = OutputStreamWriter(started.outputStream, StandardCharsets.UTF_8)
            }
            AppExecutorUtil.getAppExecutorService().execute { drain(started) }
            AppExecutorUtil.getAppExecutorService().execute { read(started) }
            send(
                jsonOf(
                    "type" to "init",
                    "workspaceFolders" to listOf(workDir).map { com.google.gson.JsonPrimitive(it) },
                    "settings" to settingsJson(),
                    "storageDir" to storageDir().toString(),
                    "extensionDir" to engineDir.toString(),
                    "version" to pluginVersion(),
                ),
            )
        } catch (e: Exception) {
            LOG.warn("Could not start the engine", e)
            fail("The engine could not be started: ${e.message}")
        }
    }

    private fun fail(message: String) {
        problem = message
        status = EngineStatus.FAILED
        notifyState()
    }

    /** The engine's files sit beside the plugin's jar (see prepareSandbox in build.gradle.kts), as it needs real files. */
    fun enginePath(): Path? = pluginDir()?.resolve("engine")?.takeIf { Files.isRegularFile(it.resolve("dist/sidecar.js")) }

    /** One folder per project: the engine writes its hook and MCP files there, and two windows must not share them. */
    private fun storageDir(): Path = PathManager.getSystemDir().resolve("claudestrator").resolve(project.locationHash)

    /** The plugin's folder: the jar sits in its `lib/`. (The platform's own lookup of it is internal API.) */
    private fun pluginDir(): Path? = runCatching { Path.of(EngineService::class.java.protectionDomain.codeSource.location.toURI()).parent?.parent }.getOrNull()

    /** Set by Gradle (processResources) from `pluginVersion`. */
    private fun pluginVersion(): String = EngineService::class.java.getResourceAsStream("/claudestrator.properties")?.use { java.util.Properties().apply { load(it) }.getProperty("version") } ?: "0.0.0"

    /** The setting, else `node` on the PATH of the login shell (an IDE started from the Dock has a bare one). */
    private fun findNode(): String? {
        val configured = ClaudestratorSettings.get().nodePath.trim()
        if (configured.isNotEmpty()) return configured.takeIf { File(it).canExecute() }
        return findOnPath("node")
    }

    /**
     * `name` in the folders of the login shell's PATH (an IDE started from the Dock has a bare one). The platform's own
     * lookup is deprecated in some IDE versions and missing its replacement in others, so it is not used.
     */
    private fun findOnPath(name: String): String? {
        val windows = System.getProperty("os.name").startsWith("Windows")
        val names = if (windows) listOf("$name.exe", "$name.cmd", "$name.bat") else listOf(name)
        return (EnvironmentUtil.getValue("PATH") ?: System.getenv("PATH") ?: "").split(File.pathSeparator).filter { it.isNotBlank() }
            .flatMap { dir -> names.map { File(dir, it) } }
            .firstOrNull { it.isFile && it.canExecute() }?.path
    }

    private fun settingsJson(): JsonObject {
        val o = JsonObject()
        for ((k, v) in SettingsBridge.snapshot(project)) {
            when (v) {
                is String -> o.addProperty(k, v)
                is Boolean -> o.addProperty(k, v)
                is List<*> -> o.add(k, com.google.gson.JsonArray().also { a -> v.forEach { a.add(it.toString()) } })
            }
        }
        return o
    }

    // ---------- the wire ----------

    @Synchronized
    fun send(message: JsonObject) {
        val w = writer ?: return
        try {
            w.write(message.toString())
            w.write("\n")
            w.flush()
        } catch (e: Exception) {
            LOG.warn("Could not write to the engine", e)
        }
    }

    /** Asks the engine to do something (resume a task, stop one…); the answer is its result, or an exception. */
    fun call(method: String, params: JsonObject = JsonObject()): CompletableFuture<JsonElement?> {
        val id = nextCall.getAndIncrement()
        val future = CompletableFuture<JsonElement?>()
        synchronized(pending) { pending[id] = future }
        if (status != EngineStatus.RUNNING) future.completeExceptionally(IllegalStateException(problem ?: "The engine is not running."))
        else send(jsonOf("type" to "call", "id" to id, "method" to method, "params" to params))
        return future
    }

    fun respond(id: Int, data: JsonElement?) = send(jsonOf("type" to "res", "id" to id, "ok" to true, "data" to data))

    fun respondError(id: Int, message: String) = send(jsonOf("type" to "res", "id" to id, "ok" to false, "error" to message))

    private fun read(started: Process) {
        BufferedReader(InputStreamReader(started.inputStream, StandardCharsets.UTF_8)).use { reader ->
            reader.lineSequence().forEach { line ->
                val msg = try {
                    JsonParser.parseString(line) as? JsonObject
                } catch (e: Exception) {
                    LOG.warn("Not JSON from the engine: ${line.take(200)}")
                    null
                }
                if (msg != null) dispatch(msg)
            }
        }
        onExit(started)
    }

    /** The engine logs on stderr; read it so the pipe never fills and the process never stalls. */
    private fun drain(started: Process) {
        started.errorStream.bufferedReader(StandardCharsets.UTF_8).useLines { lines -> lines.forEach { LOG.info("[engine] $it") } }
    }

    private fun dispatch(msg: JsonObject) {
        when (msg.str("type")) {
            "ready" -> {
                status = EngineStatus.RUNNING
                // The page's boot request can arrive before this; nothing was lost, the engine answers from its own state.
                notifyState()
            }
            "fatal" -> fail(msg.str("message") ?: "The engine stopped.")
            "post" -> msg.get("msg")?.let { page -> pageSinks.forEach { it(page.toString()) } }
            "revealDashboard" -> ApplicationManager.getApplication().invokeLater { DashboardEditorProvider.reveal(project) }
            "state" -> {
                state = EngineState.parse(msg)
                notifyState()
            }
            "engine" -> notifier.onEngineEvent(msg.str("name") ?: return, msg.get("data"))
            "req" -> {
                val id = msg.int("id") ?: return
                val method = msg.str("method") ?: return
                // Each request on its own thread: a dialog waits for the user and must not hold up the next message.
                AppExecutorUtil.getAppExecutorService().execute { hostRequests.handle(id, method, msg.get("params")) }
            }
            "res" -> {
                val id = msg.int("id") ?: return
                val future = synchronized(pending) { pending.remove(id) } ?: return
                if (msg.bool("ok")) future.complete(msg.get("data")) else future.completeExceptionally(RuntimeException(msg.str("error") ?: "failed"))
            }
        }
    }

    private fun onExit(exited: Process) {
        val unexpected = process === exited && status != EngineStatus.STOPPED
        synchronized(this) {
            if (process === exited) {
                process = null
                writer = null
            }
        }
        synchronized(pending) {
            pending.values.forEach { it.completeExceptionally(IllegalStateException("The engine stopped.")) }
            pending.clear()
        }
        if (unexpected && status != EngineStatus.FAILED) {
            problem = "The engine stopped (exit code ${runCatching { exited.exitValue() }.getOrNull() ?: "?"}). Tasks that were running can be resumed."
            status = EngineStatus.FAILED
        } else if (status != EngineStatus.FAILED) {
            status = EngineStatus.STOPPED
        }
        state = EngineState.EMPTY
        notifyState()
    }

    // ---------- what the UI listens to ----------

    fun addStateListener(parent: Disposable, listener: () -> Unit) {
        stateListeners.add(listener)
        com.intellij.openapi.util.Disposer.register(parent) { stateListeners.remove(listener) }
    }

    /** `sink` gets every message the engine posts to the dashboard page, as JSON text, on a background thread. */
    fun addPageSink(parent: Disposable, sink: (String) -> Unit) {
        pageSinks.add(sink)
        com.intellij.openapi.util.Disposer.register(parent) { pageSinks.remove(sink) }
    }

    private fun notifyState() = ApplicationManager.getApplication().invokeLater({ stateListeners.forEach { it() } }, project.disposed)

    fun pageMessage(msg: JsonElement) = send(jsonOf("type" to "page", "msg" to msg))

    fun dashboardClosed() = send(jsonOf("type" to "dashboardClosed"))

    fun settingsChanged(changed: List<String>) = send(jsonOf("type" to "settings", "settings" to settingsJson(), "changed" to changed))

    fun terminalClosed(id: Int, code: Int?) = send(jsonOf("type" to "terminalClosed", "id" to id, "code" to code))

    /** Opens the dashboard on `route` (`{ name: 'home', compose: '…' }`), starting the engine if need be. */
    fun openDashboard(route: JsonObject?) {
        if (status == EngineStatus.FAILED || status == EngineStatus.STOPPED) ensureStarted()
        if (status == EngineStatus.FAILED) return notifier.engineProblem(problem)
        // Until it is ready the engine has not read its settings; the message waits in the pipe, in order.
        send(jsonOf("type" to "dashboard", "route" to route))
    }

    // ---------- shutdown ----------

    private fun stopProcess() {
        val p = process ?: return
        status = EngineStatus.STOPPED
        send(jsonOf("type" to "shutdown"))
        // Agents are children of the engine and must stop cleanly so their tasks resume from the same step.
        AppExecutorUtil.getAppExecutorService().execute {
            if (!p.waitFor(STOP_GRACE_SECONDS, TimeUnit.SECONDS)) p.destroyForcibly()
        }
    }

    override fun dispose() = stopProcess()

    companion object {
        private const val STOP_GRACE_SECONDS = 10L

        fun getInstance(project: Project): EngineService = project.service()
    }
}
