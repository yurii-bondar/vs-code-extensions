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
 * One run of the Node process. Everything that belongs to a run lives here, so an old process that is still exiting
 * after a restart cannot touch the new one: its exit, its answers and its calls in flight are its own.
 */
private class Session(val process: Process) {
    val writer = OutputStreamWriter(process.outputStream, StandardCharsets.UTF_8)
    val pending = HashMap<Int, CompletableFuture<JsonElement?>>()

    fun failPending(message: String) {
        val calls = synchronized(pending) { pending.values.toList().also { pending.clear() } }
        calls.forEach { it.completeExceptionally(IllegalStateException(message)) }
    }
}

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
    private val nextCall = AtomicInteger(1)
    private val hostRequests = HostRequests(project, this)
    private val notifier = Notifier(project, this)

    /** Guards the lifecycle: `current`, `generation`, `disposed`, `dashboardRequest` and status changes. */
    private val lock = Any()

    /** Guards writes to the pipe; separate from `lock` so a UI thread that sends never waits on a start or a stop. */
    private val writeLock = Any()

    @Volatile private var current: Session? = null

    /** Bumped by every start and stop: a launch that finds a different number was superseded on its way. */
    private var generation = 0
    private var disposed = false

    /** The dashboard asked for while the engine was not ready; opened once it is (or reported if it fails). */
    private var dashboardRequest: JsonObject? = null

    /** When the list was last told about a state; the engine re-sends an unchanged one every minute so ages move on. */
    @Volatile private var lastNotified = 0L

    // ---------- lifecycle ----------

    /** Starts the engine unless it runs or is starting. Returns at once; the outcome is `status`. */
    fun ensureStarted() {
        synchronized(lock) {
            if (disposed || status == EngineStatus.STARTING || status == EngineStatus.RUNNING) return
            status = EngineStatus.STARTING
            problem = null
            val gen = ++generation
            AppExecutorUtil.getAppExecutorService().execute { launch(gen) }
        }
        notifyState()
    }

    fun restart() {
        synchronized(lock) {
            stopCurrent()
            status = EngineStatus.STOPPED
        }
        ensureStarted()
    }

    private fun launch(gen: Int) {
        try {
            val node = findNode() ?: return fail(gen, "Node.js was not found. Install Node.js 20 or newer, or set its path in Settings | Tools | Claudestrator.")
            val engineDir = enginePath() ?: return fail(gen, "The plugin's engine files are missing; reinstall the plugin.")
            val workDir = project.basePath ?: return fail(gen, "Open a project folder to use Claudestrator.")
            val cmd = GeneralCommandLine(node, engineDir.resolve("dist/sidecar.js").toString())
                .withWorkDirectory(workDir)
                .withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE)
                .withCharset(StandardCharsets.UTF_8)
            val session = Session(cmd.createProcess())
            synchronized(lock) {
                // Finding Node can take a while (the login shell's PATH); the project may have closed, or a restart come.
                if (disposed || gen != generation) {
                    session.process.destroyForcibly()
                    return
                }
                current = session
            }
            AppExecutorUtil.getAppExecutorService().execute { drain(session.process) }
            AppExecutorUtil.getAppExecutorService().execute { read(session) }
            write(
                session,
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
            fail(gen, "The engine could not be started: ${e.message}")
        }
    }

    /** The start numbered `gen` failed. If a dashboard was waiting for it, say why, or the click would just do nothing. */
    private fun fail(gen: Int, message: String) {
        val waiting = synchronized(lock) {
            if (gen != generation) return
            problem = message
            status = EngineStatus.FAILED
            dashboardRequest.also { dashboardRequest = null }
        }
        notifyState()
        if (waiting != null) notifier.engineProblem(message)
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

    /** To the engine that runs now; dropped when none does (a request made then is answered by `call` instead). */
    fun send(message: JsonObject) {
        val s = current ?: return
        write(s, message)
    }

    private fun write(s: Session, message: JsonObject) {
        synchronized(writeLock) {
            try {
                s.writer.write(message.toString())
                s.writer.write("\n")
                s.writer.flush()
            } catch (e: Exception) {
                LOG.warn("Could not write to the engine", e)
            }
        }
    }

    /** Asks the engine to do something (resume a task, stop one…); the answer is its result, or an exception. */
    fun call(method: String, params: JsonObject = JsonObject()): CompletableFuture<JsonElement?> {
        val future = CompletableFuture<JsonElement?>()
        val s = current
        if (s == null || status != EngineStatus.RUNNING) {
            future.completeExceptionally(IllegalStateException(problem ?: "The engine is not running."))
            return future
        }
        val id = nextCall.getAndIncrement()
        synchronized(s.pending) { s.pending[id] = future }
        write(s, jsonOf("type" to "call", "id" to id, "method" to method, "params" to params))
        return future
    }

    fun respond(id: Int, data: JsonElement?) = send(jsonOf("type" to "res", "id" to id, "ok" to true, "data" to data))

    fun respondError(id: Int, message: String) = send(jsonOf("type" to "res", "id" to id, "ok" to false, "error" to message))

    private fun read(s: Session) {
        try {
            BufferedReader(InputStreamReader(s.process.inputStream, StandardCharsets.UTF_8)).use { reader ->
                reader.lineSequence().forEach { line ->
                    val msg = try {
                        JsonParser.parseString(line) as? JsonObject
                    } catch (e: Exception) {
                        LOG.warn("Not JSON from the engine: ${line.take(200)}")
                        null
                    }
                    // One message that cannot be handled (the project closing under it, say) must not end the reading.
                    if (msg != null) {
                        try {
                            dispatch(s, msg)
                        } catch (e: Exception) {
                            LOG.warn("Could not handle a message from the engine (${msg.str("type")})", e)
                        }
                    }
                }
            }
        } catch (e: Exception) {
            LOG.info("Reading from the engine ended: ${e.message}")
        } finally {
            onExit(s)
        }
    }

    /** The engine logs on stderr; read it so the pipe never fills and the process never stalls. */
    private fun drain(process: Process) {
        runCatching { process.errorStream.bufferedReader(StandardCharsets.UTF_8).useLines { lines -> lines.forEach { LOG.info("[engine] $it") } } }
    }

    private fun dispatch(s: Session, msg: JsonObject) {
        val type = msg.str("type")
        if (type == "res") {
            val id = msg.int("id") ?: return
            val future = synchronized(s.pending) { s.pending.remove(id) } ?: return
            if (msg.bool("ok")) future.complete(msg.get("data")) else future.completeExceptionally(RuntimeException(msg.str("error") ?: "failed"))
            return
        }
        // An engine that was stopped or replaced may still be talking while it exits; only the current one is heard.
        if (s !== current) return
        when (type) {
            "ready" -> ready()
            "fatal" -> fail(synchronized(lock) { generation }, msg.str("message") ?: "The engine stopped.")
            "post" -> msg.get("msg")?.let { page -> pageSinks.forEach { it(page.toString()) } }
            "revealDashboard" -> ApplicationManager.getApplication().invokeLater({ DashboardEditorProvider.reveal(project) }, project.disposed)
            "state" -> {
                val next = EngineState.parse(msg)
                val now = System.currentTimeMillis()
                // Streaming output sends the same list many times a second; the list is rebuilt only when it changed.
                if (next == state && now - lastNotified < AGES_REFRESH_MS) return
                state = next
                notifyState()
            }
            "engine" -> {
                val name = msg.str("name") ?: return
                ApplicationManager.getApplication().invokeLater({ notifier.onEngineEvent(name, msg.get("data")) }, project.disposed)
            }
            "req" -> {
                val id = msg.int("id") ?: return
                val method = msg.str("method") ?: return
                // Each request on its own thread: a dialog waits for the user and must not hold up the next message.
                AppExecutorUtil.getAppExecutorService().execute { hostRequests.handle(id, method, msg.get("params")) }
            }
        }
    }

    /**
     * The engine has read its settings. A dashboard asked for meanwhile opens now; one already open (the engine was
     * restarted under it) is attached to the new engine, or every request of the page would go nowhere.
     */
    private fun ready() {
        val asked = synchronized(lock) {
            status = EngineStatus.RUNNING
            dashboardRequest.also { dashboardRequest = null }
        }
        notifyState()
        when {
            asked != null -> send(jsonOf("type" to "dashboard", "route" to asked))
            DashboardEditorProvider.hasOpenTab(project) -> send(jsonOf("type" to "dashboard", "reveal" to false))
        }
    }

    /** The process `s` has ended. Expected when it was stopped or replaced; otherwise the engine failed. */
    private fun onExit(s: Session) {
        s.failPending("The engine stopped.")
        val unexpected = synchronized(lock) {
            if (current !== s) return
            current = null
            if (status != EngineStatus.FAILED) {
                problem = "The engine stopped (exit code ${runCatching { s.process.exitValue() }.getOrNull() ?: "?"}). Tasks that were running can be resumed."
                status = EngineStatus.FAILED
            }
            true
        }
        if (unexpected) {
            state = EngineState.EMPTY
            notifyState()
        }
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

    private fun notifyState() {
        lastNotified = System.currentTimeMillis()
        ApplicationManager.getApplication().invokeLater({ stateListeners.forEach { it() } }, project.disposed)
    }

    fun pageMessage(msg: JsonElement) = send(jsonOf("type" to "page", "msg" to msg))

    fun dashboardClosed() = send(jsonOf("type" to "dashboardClosed"))

    fun settingsChanged(changed: List<String>) = send(jsonOf("type" to "settings", "settings" to settingsJson(), "changed" to changed))

    fun terminalClosed(id: Int, code: Int?) = send(jsonOf("type" to "terminalClosed", "id" to id, "code" to code))

    /**
     * Opens the dashboard on `route` (`{ name: 'home', compose: '…' }`). While the engine is starting (or after it
     * failed, which starts it again) the route waits for it; a start that fails says why.
     */
    fun openDashboard(route: JsonObject) {
        val now = synchronized(lock) {
            if (status == EngineStatus.RUNNING) {
                true
            } else {
                dashboardRequest = route
                false
            }
        }
        if (now) send(jsonOf("type" to "dashboard", "route" to route)) else ensureStarted()
    }

    // ---------- shutdown ----------

    /** Stops the engine that runs now, if any; a start still on its way is cancelled too. Call under `lock`. */
    private fun stopCurrent() {
        generation++
        val s = current ?: return
        current = null
        state = EngineState.EMPTY
        s.failPending("The engine stopped.")
        // Taken before the engine is told to stop: once Node has exited, its children no longer show as its descendants.
        val tree = runCatching { s.process.toHandle().descendants().toList() }.getOrDefault(emptyList())
        write(s, jsonOf("type" to "shutdown"))
        AppExecutorUtil.getAppExecutorService().execute { stopTree(s.process, tree) }
    }

    /**
     * Agents are children of the engine. They get the grace period to stop cleanly, so their tasks resume from the same
     * step; whatever of `tree` is still alive after it is killed.
     */
    private fun stopTree(process: Process, tree: List<ProcessHandle>) {
        if (!process.waitFor(STOP_GRACE_SECONDS, TimeUnit.SECONDS)) process.destroyForcibly()
        tree.filter { it.isAlive }.forEach { it.destroyForcibly() }
    }

    override fun dispose() {
        synchronized(lock) {
            disposed = true
            dashboardRequest = null
            stopCurrent()
            status = EngineStatus.STOPPED
        }
    }

    companion object {
        private const val STOP_GRACE_SECONDS = 10L
        private const val AGES_REFRESH_MS = 50_000L

        fun getInstance(project: Project): EngineService = project.service()
    }
}
