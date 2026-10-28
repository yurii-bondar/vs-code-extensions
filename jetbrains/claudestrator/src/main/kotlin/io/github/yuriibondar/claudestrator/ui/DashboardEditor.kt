package io.github.yuriibondar.claudestrator.ui

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.intellij.ide.BrowserUtil
import com.intellij.ide.ui.LafManagerListener
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.fileEditor.FileEditorPolicy
import com.intellij.openapi.fileEditor.FileEditorProvider
import com.intellij.openapi.fileEditor.FileEditorState
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.util.Key
import com.intellij.openapi.util.UserDataHolderBase
import com.intellij.openapi.util.UserDataHolderEx
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.testFramework.LightVirtualFile
import com.intellij.ui.components.JBLabel
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import com.intellij.ui.jcef.JBCefBrowserBase
import com.intellij.ui.jcef.JBCefJSQuery
import io.github.yuriibondar.claudestrator.engine.EngineService
import org.cef.browser.CefBrowser
import org.cef.browser.CefFrame
import org.cef.handler.CefLoadHandlerAdapter
import org.cef.handler.CefRequestHandlerAdapter
import org.cef.network.CefRequest
import java.beans.PropertyChangeListener
import java.awt.BorderLayout
import java.util.concurrent.atomic.AtomicInteger
import javax.swing.JComponent
import javax.swing.JPanel
import javax.swing.SwingConstants

private val LOG = logger<DashboardEditor>()

/** The project's value under `key`, made by `make` the first time; two threads asking at once get the same one. */
private fun <T : Any> once(project: Project, key: Key<T>, make: () -> T): T =
    project.getUserData(key)
        ?: (project as? UserDataHolderEx)?.putUserDataIfAbsent(key, make())
        ?: synchronized(project) { project.getUserData(key) ?: make().also { project.putUserData(key, it) } }

/** The dashboard's tab. One per project; the file stands for it and has no content on disk. */
class DashboardFile : LightVirtualFile("Claudestrator")

class DashboardEditorProvider : FileEditorProvider, DumbAware {
    override fun accept(project: Project, file: VirtualFile): Boolean = file is DashboardFile

    override fun createEditor(project: Project, file: VirtualFile): FileEditor = DashboardEditor(project, file)

    override fun getEditorTypeId(): String = "claudestrator-dashboard"

    override fun getPolicy(): FileEditorPolicy = FileEditorPolicy.HIDE_DEFAULT_EDITOR

    companion object {
        private val FILE = Key.create<DashboardFile>("claudestrator.dashboardFile")

        private fun file(project: Project): DashboardFile = once(project, FILE) { DashboardFile() }

        /** Opens the tab, or brings it forward. */
        fun reveal(project: Project) {
            OpenFileDescriptor(project, file(project)).navigate(true)
        }

        /** Whether the dashboard is what you are looking at; the notifications stay quiet then, as in VS Code. */
        fun isVisible(project: Project): Boolean = FileEditorManager.getInstance(project).selectedEditors.any { it is DashboardEditor }

        /** Whether a dashboard tab is open, on any thread (a restarted engine re-attaches to it). */
        fun hasOpenTab(project: Project): Boolean = DashboardEditor.openTabs(project).get() > 0
    }
}

/**
 * The extension's dashboard page in the IDE's embedded browser (JCEF). The page talks to the engine through the same
 * messages as in VS Code; this class only carries them across (see PageHtml for what the page is given).
 */
class DashboardEditor(private val project: Project, private val file: VirtualFile) : UserDataHolderBase(), FileEditor {
    private val root = JPanel(BorderLayout())
    private val engine = EngineService.getInstance(project)
    private val gson = Gson()
    private val lock = Any()
    private val waiting = ArrayDeque<String>()
    private var loaded = false
    private var browser: JBCefBrowser? = null

    init {
        openTabs(project).incrementAndGet()
        if (!JBCefApp.isSupported()) {
            root.add(JBLabel("<html><center>Claudestrator's dashboard needs the IDE's embedded browser (JCEF), which this IDE does not have.<br>Use an IDE build that bundles JCEF, or the Claudestrator extension for VS Code.</center></html>", SwingConstants.CENTER))
        } else {
            createBrowser()
        }
        engine.ensureStarted()
    }

    private fun createBrowser() {
        val enginePath = engine.enginePath()
        if (enginePath == null) {
            root.add(JBLabel("The plugin's engine files are missing; reinstall the plugin.", SwingConstants.CENTER))
            return
        }
        val b = JBCefBrowser()
        browser = b
        Disposer.register(this, b)
        root.add(b.component, BorderLayout.CENTER)

        val query = JBCefJSQuery.create(b as JBCefBrowserBase)
        Disposer.register(this, query)
        query.addHandler { message ->
            try {
                engine.pageMessage(JsonParser.parseString(message))
            } catch (e: Exception) {
                LOG.warn("Bad message from the page", e)
            }
            null
        }

        b.jbCefClient.addLoadHandler(object : CefLoadHandlerAdapter() {
            // A page that reloads (it can, in JCEF) gets the messages of the meantime once it is back, not into the void.
            override fun onLoadStart(browser: CefBrowser, frame: CefFrame, transitionType: CefRequest.TransitionType) {
                if (frame.isMain) synchronized(lock) { loaded = false }
            }

            override fun onLoadEnd(browser: CefBrowser, frame: CefFrame, httpStatusCode: Int) {
                if (!frame.isMain) return
                synchronized(lock) {
                    loaded = true
                    waiting.forEach(::run)
                    waiting.clear()
                }
            }
        }, b.cefBrowser)

        // A link in the page must not replace the dashboard; web links open in the system browser.
        b.jbCefClient.addRequestHandler(object : CefRequestHandlerAdapter() {
            override fun onBeforeBrowse(browser: CefBrowser, frame: CefFrame, request: CefRequest, userGesture: Boolean, isRedirect: Boolean): Boolean {
                val url = request.url
                if (url.startsWith("https://") || url.startsWith("http://")) BrowserUtil.browse(url)
                return url.startsWith("https://") || url.startsWith("http://") || url.startsWith("mailto:")
            }

            override fun onOpenURLFromTab(browser: CefBrowser, frame: CefFrame, targetUrl: String, userGesture: Boolean): Boolean {
                if (targetUrl.startsWith("https://") || targetUrl.startsWith("http://")) BrowserUtil.browse(targetUrl)
                return true
            }
        }, b.cefBrowser)

        engine.addPageSink(this) { json -> deliver(json) }
        ApplicationManager.getApplication().messageBus.connect(this).subscribe(LafManagerListener.TOPIC, LafManagerListener { restyle() })

        b.loadHTML(PageHtml.build(enginePath, query.inject("s")))
    }

    /**
     * A message from the engine for the page; held until the page has loaded. One lock around both paths, so a message
     * that arrives while the held ones are being handed over cannot overtake them.
     */
    private fun deliver(json: String) {
        synchronized(lock) {
            if (loaded) run(json) else waiting.add(json)
        }
    }

    private fun run(json: String) {
        val b = browser ?: return
        b.cefBrowser.executeJavaScript("window.__csReceive($json)", b.cefBrowser.url, 0)
    }

    /** A new IDE theme: the page keeps its state and only gets new colors. */
    private fun restyle() {
        val b = browser ?: return
        b.cefBrowser.executeJavaScript("document.getElementById('ide-theme').textContent = ${gson.toJson(ThemeCss.build())}", b.cefBrowser.url, 0)
    }

    override fun getComponent(): JComponent = root

    override fun getPreferredFocusedComponent(): JComponent? = browser?.component

    override fun getName(): String = "Claudestrator"

    override fun getFile(): VirtualFile = file

    override fun setState(state: FileEditorState) = Unit

    override fun isModified(): Boolean = false

    override fun isValid(): Boolean = true

    override fun addPropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun removePropertyChangeListener(listener: PropertyChangeListener) = Unit

    override fun dispose() {
        // The last tab closing ends the dashboard in the engine, so the next open starts from the route it is given.
        if (openTabs(project).decrementAndGet() == 0) engine.dashboardClosed()
    }

    internal companion object {
        private val TABS = Key.create<AtomicInteger>("claudestrator.dashboardTabs")

        fun openTabs(project: Project): AtomicInteger = once(project, TABS) { AtomicInteger() }
    }
}
