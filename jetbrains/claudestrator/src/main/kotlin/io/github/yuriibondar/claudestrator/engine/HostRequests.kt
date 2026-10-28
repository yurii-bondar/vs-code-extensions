package io.github.yuriibondar.claudestrator.engine

import com.google.gson.JsonElement
import com.google.gson.JsonNull
import com.google.gson.JsonObject
import com.google.gson.JsonPrimitive
import com.intellij.credentialStore.CredentialAttributes
import com.intellij.credentialStore.Credentials
import com.intellij.credentialStore.generateServiceName
import com.intellij.execution.RunContentExecutor
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessListener
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessHandler
import com.intellij.ide.BrowserUtil
import com.intellij.ide.actions.RevealFileAction
import com.intellij.openapi.ide.CopyPasteManager
import com.intellij.ide.projectView.ProjectView
import com.intellij.ide.passwordSafe.PasswordSafe
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.fileChooser.FileChooserDescriptor
import com.intellij.openapi.fileChooser.FileChooserFactory
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VirtualFile
import io.github.yuriibondar.claudestrator.settings.SettingsBridge
import java.awt.datatransfer.StringSelection
import java.io.File
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * What the engine asks of an editor: show a message, open a file, pick a folder, keep a secret, run a terminal.
 * The sidecar's `vscode` stand-in (sidecar/src/vscode-shim.ts) makes the requests; each gets exactly one answer.
 */
internal class HostRequests(private val project: Project, private val engine: EngineService) {
    private val processes = ConcurrentHashMap<Int, ProcessHandler>()
    private val shells = ConcurrentHashMap<Int, InteractiveShell.Session>()

    fun handle(id: Int, method: String, params: JsonElement?) {
        val p = params as? JsonObject ?: JsonObject()
        try {
            when (method) {
                "showMessage" -> showMessage(p) { engine.respond(id, it?.let(::JsonPrimitive)) }
                "openDialog" -> onEdt { engine.respond(id, openDialog(p)) }
                "openFile" -> onEdt { openFile(p); engine.respond(id, null) }
                "reveal" -> onEdt { reveal(p); engine.respond(id, null) }
                "openExternal" -> engine.respond(id, null).also { openExternal(p.str("url")) }
                "clipboard" -> engine.respond(id, null).also { CopyPasteManager.getInstance().setContents(StringSelection(p.str("text") ?: "")) }
                "secret" -> engine.respond(id, secret(p))
                "setSetting" -> engine.respond(id, null).also { SettingsBridge.apply(project, p.str("key") ?: return@also, p.get("value") ?: JsonNull.INSTANCE) }
                "terminalOpen" -> engine.respond(id, null).also { terminalOpen(p) }
                "terminalShow" -> engine.respond(id, null).also { p.int("id")?.let { n -> shells[n]?.show() } }
                "terminalSend" -> engine.respond(id, null).also { p.int("id")?.let { n -> shells[n]?.send(p.str("text") ?: "") } }
                "terminalClose" -> engine.respond(id, null).also { terminalClose(p.int("id")) }
                else -> engine.respondError(id, "unknown request $method")
            }
        } catch (e: Exception) {
            engine.respondError(id, e.message ?: e.javaClass.simpleName)
        }
    }

    private fun onEdt(block: () -> Unit) = ApplicationManager.getApplication().invokeLater(block, project.disposed)

    // ---------- messages ----------

    /**
     * A modal one blocks until a button is pressed (the engine uses these to confirm what cannot be undone);
     * the others are balloons whose buttons answer, and whose dismissal answers "nothing".
     */
    private fun showMessage(p: JsonObject, answer: (String?) -> Unit) {
        val level = p.str("level") ?: "info"
        val message = p.str("message") ?: ""
        val detail = p.str("detail")
        val items = p.array("items").map { it.asString }
        if (p.bool("modal")) {
            onEdt {
                val choices = (items + "Cancel").toTypedArray()
                val icon = when (level) {
                    "error" -> Messages.getErrorIcon()
                    "warning" -> Messages.getWarningIcon()
                    else -> Messages.getInformationIcon()
                }
                // The safe button has the focus: Enter must not confirm a deletion.
                val picked = Messages.showDialog(project, listOfNotNull(message, detail).joinToString("\n\n"), "Claudestrator", choices, choices.lastIndex, icon)
                answer(items.getOrNull(picked))
            }
            return
        }
        val type = when (level) {
            "error" -> NotificationType.ERROR
            "warning" -> NotificationType.WARNING
            else -> NotificationType.INFORMATION
        }
        val done = AtomicBoolean(false)
        val reply = { choice: String? -> if (done.compareAndSet(false, true)) answer(choice) }
        val notification = NotificationGroupManager.getInstance().getNotificationGroup("Claudestrator").createNotification("Claudestrator", message, type)
        if (detail != null) notification.setSubtitle(detail)
        items.forEach { item -> notification.addAction(NotificationAction.createSimpleExpiring(item) { reply(item) }) }
        notification.whenExpired { reply(null) }
        if (items.isEmpty()) reply(null)
        notification.notify(project)
    }

    // ---------- files ----------

    private fun openDialog(p: JsonObject): JsonElement {
        val folders = p.bool("canSelectFolders")
        val files = p.get("canSelectFiles")?.let { p.bool("canSelectFiles") } ?: !folders
        val descriptor = FileChooserDescriptor(files, folders, false, false, false, p.bool("canSelectMany"))
        p.str("title")?.let { descriptor.title = it }
        p.str("openLabel")?.let { descriptor.description = it }
        val start = p.str("defaultPath")?.let { LocalFileSystem.getInstance().refreshAndFindFileByPath(it) }
        val chosen = FileChooserFactory.getInstance().createFileChooser(descriptor, project, null).choose(project, start)
        if (chosen.isEmpty()) return JsonNull.INSTANCE
        return com.google.gson.JsonArray().also { a -> chosen.forEach { a.add(it.path) } }
    }

    private fun openFile(p: JsonObject) {
        val vf = localFile(p.str("path") ?: return) ?: return
        OpenFileDescriptor(project, vf).navigate(true)
    }

    private fun reveal(p: JsonObject) {
        val path = p.str("path") ?: return
        if (p.bool("inOS")) return RevealFileAction.openFile(File(path))
        localFile(path)?.let { ProjectView.getInstance(project).select(null, it, true) }
    }

    private fun localFile(path: String): VirtualFile? = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(File(path))

    /** The engine gives links from its own data (a PR address, a docs link); only web links leave the IDE. */
    private fun openExternal(url: String?) {
        if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) BrowserUtil.browse(url)
    }

    // ---------- secrets ----------

    private fun secret(p: JsonObject): JsonElement {
        val key = p.str("key") ?: error("secret: no key")
        val attributes = CredentialAttributes(generateServiceName("Claudestrator", key))
        val safe = PasswordSafe.instance
        return when (p.str("op")) {
            "get" -> safe.getPassword(attributes)?.let(::JsonPrimitive) ?: JsonNull.INSTANCE
            "store" -> JsonNull.INSTANCE.also { safe.set(attributes, Credentials(key, p.str("value") ?: "")) }
            "delete" -> JsonNull.INSTANCE.also { safe.set(attributes, null) }
            else -> error("secret: unknown operation")
        }
    }

    // ---------- terminals ----------

    private fun terminalOpen(p: JsonObject) {
        val id = p.int("id") ?: return
        val name = p.str("name") ?: "Claude"
        val cwd = p.str("cwd") ?: project.basePath
        val command = p.get("command")?.takeIf { it.isJsonArray }?.asJsonArray?.map { it.asString }
        if (command != null) runProcess(id, name, command, cwd, p.obj("env"))
        else openShell(id, cwd)
    }

    /** A one-off process (a sign-in) in the Run tool window; the engine hears when it ends. */
    private fun runProcess(id: Int, name: String, command: List<String>, cwd: String?, env: JsonObject?) {
        val line = GeneralCommandLine(command).withParentEnvironmentType(GeneralCommandLine.ParentEnvironmentType.CONSOLE).withCharset(StandardCharsets.UTF_8)
        cwd?.let { line.withWorkDirectory(it) }
        // `null` in the engine's env means "unset this one".
        env?.entrySet()?.forEach { (k, v) -> if (v.isJsonNull) line.environment.remove(k) else line.environment[k] = v.asString }
        val handler = OSProcessHandler(line)
        processes[id] = handler
        handler.addProcessListener(object : ProcessListener {
            override fun processTerminated(event: ProcessEvent) {
                processes.remove(id)
                engine.terminalClosed(id, event.exitCode)
            }
        })
        onEdt { RunContentExecutor(project, handler).withTitle(name).withActivateToolWindow(true).run() }
        handler.startNotify()
    }

    private fun openShell(id: Int, cwd: String?) {
        onEdt { shells[id] = InteractiveShell.open(project, cwd) }
    }

    private fun terminalClose(id: Int?) {
        id ?: return
        processes.remove(id)?.destroyProcess()
        shells.remove(id)?.close()
    }
}
