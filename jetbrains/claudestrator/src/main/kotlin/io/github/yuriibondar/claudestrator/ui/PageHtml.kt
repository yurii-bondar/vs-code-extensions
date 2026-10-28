package io.github.yuriibondar.claudestrator.ui

import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.Base64

/**
 * The dashboard page: the VS Code extension's own css and scripts (they sit in the engine folder, laid out as in
 * the extension), inlined so the browser needs no file access, under a policy that lets only these scripts run.
 */
object PageHtml {
    private val SCRIPTS = listOf("markdown.js", "app.js", "task.js", "config.js")

    /** `sendToEngine` is the JS that hands the string `s` to the plugin (JBCefJSQuery.inject). */
    fun build(engineDir: Path, sendToEngine: String): String {
        val nonce = ByteArray(16).also { SecureRandom().nextBytes(it) }.let { Base64.getEncoder().encodeToString(it) }
        val css = read(engineDir.resolve("media/app.css"))
        val scripts = SCRIPTS.joinToString("\n") { "<script nonce=\"$nonce\">${escapeScript(read(engineDir.resolve("dist/media/$it")))}</script>" }
        return """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: https:; font-src data:; script-src 'nonce-$nonce';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style id="ide-theme">${ThemeCss.build()}</style>
<style>$css</style>
<title>Claudestrator</title>
<script nonce="$nonce">
// What the page was written for, answered by the plugin: messages out through the IDE's query, messages in as events.
window.__csSend = function (s) { $sendToEngine };
window.__csReceive = function (m) { window.dispatchEvent(new MessageEvent('message', { data: m })); };
window.acquireVsCodeApi = function () {
  var state;
  return {
    postMessage: function (m) { window.__csSend(JSON.stringify(m)); },
    getState: function () { return state; },
    setState: function (s) { state = s; }
  };
};
</script>
</head>
<body>
<div id="app"><div class="boot"><div class="spinner"></div></div></div>
<div id="toasts" aria-live="polite"></div>
<div id="modal-root"></div>
$scripts
</body>
</html>"""
    }

    private fun read(file: Path): String = Files.readString(file)

    /** A script that contains `</script` would end its own tag. */
    private fun escapeScript(js: String): String = js.replace("</script", "<\\/script")
}
